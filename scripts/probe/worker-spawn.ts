/**
 * Throwaway probe (issue #16): spawn a Pi worker over RPC, make it list a directory,
 * then demonstrate cancellation without leaving orphan processes.
 *
 * No model call is made. The worker is `pi --mode rpc` started with
 * `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-session`
 * and `PI_OFFLINE=1`; the directory listing runs through the RPC `bash` command, which
 * is deterministic and needs no API key.
 *
 * What it demonstrates (see docs/adr/0004-worker-interface.md):
 *   1. spawn + readiness (`get_state`), worker in its own process group
 *   2. work: `ls -1 <dir>` via RPC `bash`, streamed `bash_execution_update` + final response
 *   3. cancellation tier 1 — cooperative: RPC `abort_bash` while a long command runs
 *   4. cancellation tier 2 — graceful: SIGTERM the worker; Pi kills its tracked children
 *   5. cancellation tier 3 — hard: SIGKILL the worker; Pi cannot clean up, so the
 *      supervisor reaps the descendant tree it snapshotted beforehand
 *   After each tier the probe verifies that no worker descendant survives.
 *
 * Run:
 *   node scripts/probe/worker-spawn.ts [dir-to-list]
 * Env: KORWF_PI_BIN (default: `pi` on PATH). Exit 0 only if every check passes.
 *
 * POSIX only for the process-tree checks (`ps`); on Windows the equivalent is
 * `taskkill /T /F` and `Get-CimInstance Win32_Process` — not exercised here.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

const PI_BIN = process.env.KORWF_PI_BIN ?? "pi";
const WORKER_ARGS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
];
const LONG_COMMAND = "sleep 300";
const GRACE_MS = 3000;
const IS_WIN = process.platform === "win32";

type RpcMessage = { type: string; id?: string; command?: string; success?: boolean; data?: any; [k: string]: unknown };

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ---------- process-tree helpers (supervisor side) ---------- */

/** All live processes as pid -> ppid. */
function processTable(): Map<number, number> {
	const table = new Map<number, number>();
	if (IS_WIN) return table; // see header; not exercised here
	const out = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
	for (const line of out.split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (pid) table.set(pid, ppid);
	}
	return table;
}

/** Transitive children of `root`, from a snapshot of the process table. */
function descendants(root: number, table = processTable()): number[] {
	const out: number[] = [];
	const queue = [root];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const [pid, ppid] of table) {
			if (ppid === parent) {
				out.push(pid);
				queue.push(pid);
			}
		}
	}
	return out;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killQuietly(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(pid, signal);
	} catch {
		/* already gone */
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await sleep(stepMs);
	}
	return pred();
}

/* ---------- RPC worker wrapper ---------- */

class Worker {
	readonly proc: ChildProcess;
	readonly pid: number;
	exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private buffer = "";
	private waiters: { match: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }[] = [];
	readonly events: RpcMessage[] = [];

	constructor(cwd: string, depth: number) {
		this.proc = spawn(PI_BIN, WORKER_ARGS, {
			cwd,
			// Own process group on POSIX so the supervisor can address the worker (and
			// anything that stays in its group) with a single negative-pid kill.
			detached: !IS_WIN,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_OFFLINE: "1",
				// Recursion guard: the orchestration extension refuses to spawn when this
				// exceeds the configured depth (ADR 0004). Workers also never get the
				// orchestration extension because of --no-extensions.
				KORWF_WORKER_DEPTH: String(depth),
			},
		});
		this.pid = this.proc.pid!;
		this.proc.stdout!.setEncoding("utf8");
		// LF-only framing (rpc.md): do not use readline, which also splits on U+2028/2029.
		this.proc.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				if (line.trim()) this.onLine(line);
			}
		});
		this.proc.stderr!.setEncoding("utf8");
		this.proc.stderr!.on("data", (d: string) => process.stderr.write(`[worker ${this.pid} stderr] ${d}`));
		this.proc.on("exit", (code, signal) => {
			this.exit = { code, signal };
			// Crash detection: anything still waiting on this worker learns it is gone.
			for (const w of this.waiters.splice(0)) w.resolve({ type: "worker_exit", code, signal });
		});
	}

	private onLine(line: string) {
		let msg: RpcMessage;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		this.events.push(msg);
		const i = this.waiters.findIndex((w) => w.match(msg));
		if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
	}

	send(cmd: Record<string, unknown>) {
		this.proc.stdin!.write(`${JSON.stringify(cmd)}\n`);
	}

	expect(match: (m: RpcMessage) => boolean, timeoutMs = 10_000): Promise<RpcMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
				reject(new Error(`timed out waiting for RPC message`));
			}, timeoutMs);
			const wrapped = (m: RpcMessage) => {
				clearTimeout(timer);
				resolve(m);
			};
			this.waiters.push({ match, resolve: wrapped });
		});
	}

	/** Send a command and await its response (matched on `id` when given). */
	async call(cmd: Record<string, unknown>, timeoutMs?: number): Promise<RpcMessage> {
		const p = this.expect(
			(m) => m.type === "response" && (cmd.id ? m.id === cmd.id : m.command === cmd.type),
			timeoutMs,
		);
		this.send(cmd);
		return p;
	}

	waitForExit(timeoutMs: number): Promise<boolean> {
		return waitUntil(() => this.exit !== undefined, timeoutMs);
	}

	/** Snapshot descendants first: after SIGKILL Pi cannot reap them and they reparent to PID 1. */
	async killTree(signal: NodeJS.Signals): Promise<number[]> {
		const snapshot = descendants(this.pid);
		if (IS_WIN) {
			execFileSync("taskkill", ["/PID", String(this.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			killQuietly(-this.pid, signal); // whole process group
			killQuietly(this.pid, signal);
		}
		const exited = await this.waitForExit(GRACE_MS);
		if (!exited) {
			killQuietly(-this.pid, "SIGKILL");
			killQuietly(this.pid, "SIGKILL");
			await this.waitForExit(GRACE_MS);
		}
		// Reap anything from the snapshot that survived (Pi's detached bash children).
		for (const pid of snapshot) killQuietly(pid, "SIGKILL");
		await waitUntil(() => snapshot.every((p) => !isAlive(p)), GRACE_MS);
		return snapshot;
	}
}

/* ---------- the probe ---------- */

async function startLongCommand(w: Worker, id: string): Promise<{ done: Promise<RpcMessage>; longPids: number[] }> {
	const done = w.expect((m) => (m.type === "response" && m.id === id) || m.type === "worker_exit", 60_000);
	w.send({ id, type: "bash", command: LONG_COMMAND });
	// Wait for the long command to appear beneath the worker.
	let longPids: number[] = [];
	await waitUntil(() => {
		longPids = descendants(w.pid);
		return longPids.length > 0;
	}, 5000);
	return { done, longPids };
}

async function main() {
	const dir = resolve(process.argv[2] ?? process.cwd());
	console.log(`worker binary: ${PI_BIN}; listing: ${dir}`);

	// 1. spawn + readiness
	const a = new Worker(dir, 1);
	const spawnError = new Promise<never>((_, reject) => a.proc.on("error", reject));
	const state = await Promise.race([a.call({ type: "get_state" }), spawnError]);
	check("1 worker spawned and answered get_state", state.success === true, `pid ${a.pid}`);
	if (!IS_WIN) {
		const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(a.pid)], { encoding: "utf8" }).trim());
		check("1 worker leads its own process group", pgid === a.pid, `pgid ${pgid}`);
	}

	// 2. real work without a model: list a directory over RPC bash
	const ls = await a.call({ id: "ls", type: "bash", command: "ls -1" });
	const listing = String(ls.data?.output ?? "");
	const streamed = a.events.filter((e) => e.type === "bash_execution_update" && e.id === "ls").length;
	console.log(listing.trimEnd().split("\n").map((l) => `  | ${l}`).join("\n"));
	check("2 directory listed via RPC bash", ls.success === true && ls.data?.exitCode === 0, `${listing.split("\n").filter(Boolean).length} entries, ${streamed} streamed update(s)`);

	// 3. tier 1: cooperative abort of a running command
	const t1 = await startLongCommand(a, "long1");
	check("3 long command started under worker", t1.longPids.length > 0, `descendants ${t1.longPids.join(",")}`);
	a.send({ type: "abort_bash" });
	const aborted = await t1.done;
	const t1Gone = await waitUntil(() => t1.longPids.every((p) => !isAlive(p)), GRACE_MS);
	check("3 abort_bash cancelled it and Pi reaped the command tree", aborted.data?.cancelled === true && t1Gone, `cancelled=${aborted.data?.cancelled}`);

	// 4. tier 2: graceful kill (SIGTERM) mid-run — Pi's signal handler kills tracked children
	const t2 = await startLongCommand(a, "long2");
	check("4 second long command started", t2.longPids.length > 0, `descendants ${t2.longPids.join(",")}`);
	const snap2 = await a.killTree("SIGTERM");
	const t2Gone = snap2.every((p) => !isAlive(p));
	check("4 SIGTERM mid-run: worker exited", a.exit !== undefined, `code=${a.exit?.code} signal=${a.exit?.signal}`);
	check("4 SIGTERM mid-run: no orphans from the snapshot", t2Gone, `checked ${snap2.length} pid(s)`);

	// 5. tier 3: hard kill (SIGKILL) — Pi cannot clean up, supervisor must reap the snapshot
	const b = new Worker(dir, 1);
	await b.call({ type: "get_state" });
	const t3 = await startLongCommand(b, "long3");
	check("5 third worker + long command started", t3.longPids.length > 0, `pid ${b.pid}, descendants ${t3.longPids.join(",")}`);
	killQuietly(b.pid, "SIGKILL");
	await b.waitForExit(GRACE_MS);
	const orphanedByKill = t3.longPids.filter(isAlive);
	console.log(`  after SIGKILL of pi: ${orphanedByKill.length} of ${t3.longPids.length} command pid(s) still alive (expected: Pi could not reap)`);
	for (const pid of t3.longPids) killQuietly(pid, "SIGKILL");
	const t3Gone = await waitUntil(() => t3.longPids.every((p) => !isAlive(p)), GRACE_MS);
	check("5 SIGKILL mid-run: worker exited", b.exit?.signal === "SIGKILL", `signal=${b.exit?.signal}`);
	check("5 SIGKILL mid-run: supervisor reaped snapshotted descendants", t3Gone, `reaped ${t3.longPids.length} pid(s)`);

	// summary
	const failed = checks.filter((c) => !c.ok);
	console.log(JSON.stringify({ checks: checks.length, failed: failed.map((c) => c.name) }));
	process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
	console.error("probe failed:", err);
	process.exitCode = 2;
});
