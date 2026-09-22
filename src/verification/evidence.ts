/**
 * Evidence capture: turning one check run into a record that a gate can read
 * (issue #45; PLAN §3.F, §2.4 (1); `docs/gates.md` §4).
 *
 * This module is the *shape* half of check running. `checks.ts` executes a
 * command; everything here is pure: it classifies what happened, fingerprints
 * the environment it happened in, redacts the captured output, and builds the
 * `Evidence` row (`src/storage/records.ts`) that `docs/gates.md` §4 maps to a
 * check state.
 *
 * Three rules this file exists to make unavoidable:
 *
 * 1. **Absence is never success.** A command that could not be executed is
 *    `unavailable`, a command that ran out of time is `timed_out`, a check with
 *    no run is `missing`. `docs/gates.md` §4: only `pass` satisfies C1, and the
 *    gate must report the distinct state name.
 * 2. **Evidence is pinned to a revision.** `Evidence.revision` is read from the
 *    worktree by `src/git/` *at run time*, not passed in by a caller and not
 *    cached, because stale evidence is the whole attack surface of the gate
 *    (`docs/gates.md` §2 "fresh evidence").
 * 3. **Nothing captured from a subprocess is stored raw.** stdout/stderr go
 *    through `src/security/redact.ts` before they reach a record or an artifact
 *    file (PLAN §7; issue #22).
 */
import { createHash } from "node:crypto";
import { sha256 } from "../storage/artifacts.ts";
import type {
  ArtifactRef,
  AttemptId,
  CheckDefinition,
  CommandIdentity,
  ContentHash,
  EnvelopeFields,
  Evidence,
  EvidenceExitStatus,
  GitSha,
  Revision,
  TaskId,
  WorkflowId,
} from "../storage/records.ts";
import { redactString } from "../security/redact.ts";

/**
 * The check states of `docs/gates.md` §4.
 *
 * A *run* can only produce `pass`, `fail`, `timeout` or `unavailable`;
 * `flaky` comes from reconciling several runs and `missing` is the state of a
 * check with no fresh evidence at all, which is a property of the store
 * rather than of a run. They are in the union so that mapping an
 * `EvidenceExitStatus` never has to collapse a state into `fail` — which
 * `docs/gates.md` §4 explicitly forbids in the audit entry.
 */
export type CheckRunStatus = "pass" | "fail" | "timeout" | "unavailable" | "flaky" | "missing";

/** Why a check could not be executed. Kept short and machine-readable. */
export type UnavailableReason =
  | "command_not_found"
  | "not_executable"
  | "spawn_failed"
  | "weak_check"
  | "cwd_missing"
  | "no_revision";

/**
 * What the environment looked like when the command ran.
 *
 * PLAN §3.F requires "environment" on evidence, and PLAN §7 forbids storing
 * anything credential-shaped. Those are reconciled by recording environment
 * variable **names only**: `PATH` tells a reader the toolchain could differ
 * between two runs; its value would leak the author's home directory, and
 * `TYPESAFE_API_KEY`'s value would leak a credential.
 */
export interface EnvironmentFingerprint {
  /** `process.version`, e.g. `v22.13.0`. */
  readonly nodeVersion: string;
  /** `process.platform`. */
  readonly platform: string;
  /** `process.arch`. */
  readonly arch: string;
  /** Sorted names of the environment variables visible to the command. Never values. */
  readonly envVarNames: readonly string[];
  /** Shell the command was run through, for command identity. */
  readonly shell: string;
}

/**
 * Environment variable names that are *relevant* to a check result.
 *
 * Recording every name of a developer's environment would make the hash
 * change on every run for reasons that have nothing to do with the check
 * (terminal size, window id, ssh agent socket). The filter keeps the names
 * that plausibly change a build's behaviour, plus anything namespaced to this
 * project or to Pi.
 */
const RELEVANT_ENV_PREFIXES: readonly string[] = ["KORWF_", "PI_", "NODE_", "NPM_", "CI"];

/** Exact names that matter regardless of prefix. */
const RELEVANT_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "HOME",
  "TMPDIR",
]);

/** Is this environment variable name worth fingerprinting? */
export function isRelevantEnvName(name: string): boolean {
  if (RELEVANT_ENV_NAMES.has(name)) return true;
  return RELEVANT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Fingerprint an environment. Takes the env map explicitly so a caller can
 * fingerprint the environment it is *about to* pass to the child rather than
 * whatever the parent happens to hold.
 */
export function fingerprintEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  runtime: { readonly nodeVersion?: string; readonly platform?: string; readonly arch?: string; readonly shell?: string } = {},
): EnvironmentFingerprint {
  const names = Object.keys(env)
    .filter((name) => env[name] !== undefined && isRelevantEnvName(name))
    .sort();
  return {
    nodeVersion: runtime.nodeVersion ?? process.version,
    platform: runtime.platform ?? process.platform,
    arch: runtime.arch ?? process.arch,
    envVarNames: names,
    shell: runtime.shell ?? DEFAULT_SHELL,
  };
}

/**
 * Shell used to run check commands.
 *
 * A registered check is a *command line* (`npm test -- foo && npm run lint`),
 * not an argv, so it needs a shell. The shell is fixed rather than read from
 * `$SHELL`: a check that passes under the engine must not depend on whether
 * the user runs fish or zsh (PLAN §7 "nothing machine-specific").
 */
export const DEFAULT_SHELL: string = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

/** Stable hash of a fingerprint, for `CommandIdentity.environmentHash`. */
export function hashEnvironment(fingerprint: EnvironmentFingerprint): ContentHash {
  const canonical = JSON.stringify({
    nodeVersion: fingerprint.nodeVersion,
    platform: fingerprint.platform,
    arch: fingerprint.arch,
    shell: fingerprint.shell,
    envVarNames: [...fingerprint.envVarNames].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Raw result of executing one check command, before it becomes a record.
 *
 * `exitCode`/`signal` are `null` when the process never ran at all, which is
 * exactly the case `unavailable` exists for.
 */
export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Set when the process was killed for exceeding its deadline. */
  readonly timedOut: boolean;
  /** Set when the command could not be executed at all. */
  readonly unavailable: UnavailableReason | null;
  /** Already-captured output. Redaction happens in `capturedOutput`. */
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Pids killed as part of the deadline enforcement, for the audit trail. */
  readonly killedPids?: readonly number[];
}

/**
 * Shell exit code for "command not found".
 *
 * This constant carries the bug that motivated this issue: `npm test`
 * exiting 127 because a binary was absent was read as "the tests failed",
 * and a day went into debugging tests that had never run. 127 from the shell
 * means the *check* could not be executed, so it is `unavailable`, which is
 * not a pass and not a fail.
 */
export const SHELL_COMMAND_NOT_FOUND = 127;

/** Shell exit code for "found but not executable". */
export const SHELL_NOT_EXECUTABLE = 126;

/**
 * Text the shell prints when it cannot find a command. Matched only in
 * combination with exit 127, so a test that legitimately prints the phrase
 * and exits 1 is still a `fail`.
 */
const NOT_FOUND_MARKERS: readonly string[] = ["command not found", "not found", "no such file or directory"];

/**
 * Did a 127 exit come from the shell failing to find the command, or from a
 * program that chose 127 as its own exit code?
 *
 * The conservative answer is the safe one in both directions: treating a
 * genuine failure as `unavailable` does not let a task through the gate
 * (`unavailable` does not satisfy C1 either), whereas treating an absent tool
 * as `fail` sends a worker off to fix tests that never ran.
 */
export function looksLikeCommandNotFound(exitCode: number | null, stderr: string): boolean {
  if (exitCode !== SHELL_COMMAND_NOT_FOUND) return false;
  const haystack = stderr.toLowerCase();
  return NOT_FOUND_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Classify a raw outcome into the `EvidenceExitStatus` union.
 *
 * Order matters and encodes the rules: unavailability first (the command
 * never ran, so its exit code means nothing), then timeout, then signals,
 * then the exit code.
 */
export function classifyOutcome(outcome: CommandOutcome): EvidenceExitStatus {
  if (outcome.unavailable !== null) {
    return { kind: "unavailable", reason: outcome.unavailable };
  }
  if (outcome.timedOut) return { kind: "timed_out" };
  if (outcome.signal !== null) return { kind: "signalled", signal: outcome.signal };
  if (outcome.exitCode === null) return { kind: "unavailable", reason: "spawn_failed" };
  if (looksLikeCommandNotFound(outcome.exitCode, outcome.stderr)) {
    return { kind: "unavailable", reason: "command_not_found" };
  }
  if (outcome.exitCode === SHELL_NOT_EXECUTABLE) {
    return { kind: "unavailable", reason: "not_executable" };
  }
  return { kind: "exited", code: outcome.exitCode };
}

/**
 * Map an exit status to the run status a reporter shows.
 *
 * Mirrors `docs/gates.md` §4 exactly, including that a mismatching exit code
 * is `fail` while an unexecutable command is `unavailable`. `pass` is only
 * ever returned for `{exited, code === expectedExitCode}`.
 */
export function runStatusOf(status: EvidenceExitStatus, expectedExitCode: number): CheckRunStatus {
  switch (status.kind) {
    case "exited":
      return status.code === expectedExitCode ? "pass" : "fail";
    case "timed_out":
      return "timeout";
    case "unavailable":
      return "unavailable";
    case "flaky":
      return "flaky";
    case "signalled":
      // A killed process produced no verdict about the code; `docs/gates.md`
      // §4 classifies `{signalled, _}` as `fail`, not as success.
      return "fail";
    case "missing":
      return "missing";
  }
}

/** Build the `CommandIdentity` a gate compares against the check definition. */
export function commandIdentityOf(
  check: Pick<CheckDefinition, "command" | "cwd">,
  fingerprint: EnvironmentFingerprint,
): CommandIdentity {
  return {
    command: check.command,
    cwd: check.cwd,
    environmentHash: hashEnvironment(fingerprint),
  };
}

/** Default cap on the bytes of each stream kept on the evidence row. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Marker inserted where output was dropped for length. */
export const TRUNCATION_MARKER = "\n[... truncated by korwf: output limit reached ...]\n";

/** Redacted, bounded output of one stream, plus what had to be done to it. */
export interface CapturedStream {
  readonly text: string;
  readonly truncated: boolean;
  /** Byte length before truncation, so a reader knows how much was dropped. */
  readonly originalBytes: number;
  readonly contentHash: ContentHash;
}

/**
 * Redact, then truncate.
 *
 * The order is the one `src/security/outbound.ts` (#28) settled on and is not
 * an implementation detail: truncating first can cut a credential in half and
 * leave a prefix that no pattern matches any more, so a redactor that runs
 * afterwards would miss it. Redacting the whole stream first means every
 * secret is already `[redacted]` before any byte is dropped.
 */
export function capturedOutput(raw: string, limitBytes = DEFAULT_OUTPUT_LIMIT_BYTES): CapturedStream {
  const redacted = redactString(raw);
  const buffer = Buffer.from(redacted, "utf8");
  const originalBytes = buffer.byteLength;
  if (originalBytes <= limitBytes) {
    return { text: redacted, truncated: false, originalBytes, contentHash: sha256(redacted) };
  }
  // Keep both ends: the head usually names the command, the tail usually
  // carries the failure. `toString` on a cut buffer can split a multi-byte
  // character, so the halves are decoded independently and any replacement
  // character lands at the cut, inside the marker's neighbourhood.
  const half = Math.max(1, Math.floor((limitBytes - Buffer.byteLength(TRUNCATION_MARKER)) / 2));
  const head = buffer.subarray(0, half).toString("utf8");
  const tail = buffer.subarray(originalBytes - half).toString("utf8");
  const text = `${head}${TRUNCATION_MARKER}${tail}`;
  return { text, truncated: true, originalBytes, contentHash: sha256(text) };
}

/**
 * An `Evidence` row minus the envelope fields the store owns (`id`,
 * `createdAt`, `updatedAt`, `schemaVersion`, `kind`).
 *
 * `runCheck` returns a draft rather than appending, for the same reason
 * `src/workflow/state.ts` separates transition from persistence: the caller
 * owns the store handle and the transaction, and a check runner that wrote
 * rows itself could not be used to *preview* a check.
 */
export type EvidenceDraft = Omit<Evidence, EnvelopeFields>;

/** Everything a draft needs that is about the workflow rather than the run. */
export interface EvidenceSubject {
  readonly workflowId: WorkflowId;
  readonly taskId: TaskId;
  /** `Task.revision` the check definition was read at (`docs/gates.md` §2). */
  readonly taskRevision: Revision;
  readonly attemptId: AttemptId | null;
  /** Acceptance-criterion id this evidence supports. */
  readonly requirementId: string;
  /** Evidence this run re-verifies, if any. */
  readonly supersedesId?: Evidence["supersedesId"];
}

/** Build the append-ready evidence draft for one executed check. */
export function buildEvidenceDraft(args: {
  readonly subject: EvidenceSubject;
  readonly check: CheckDefinition;
  readonly revision: GitSha;
  readonly fingerprint: EnvironmentFingerprint;
  readonly exitStatus: EvidenceExitStatus;
  readonly artifact: ArtifactRef | null;
  readonly caveats: readonly string[];
}): EvidenceDraft {
  const { subject, check, revision, fingerprint, exitStatus, artifact, caveats } = args;
  return {
    workflowId: subject.workflowId,
    taskId: subject.taskId,
    taskRevision: subject.taskRevision,
    attemptId: subject.attemptId,
    requirementId: subject.requirementId,
    checkId: check.id,
    artifact,
    revision,
    commandIdentity: commandIdentityOf(check, fingerprint),
    exitStatus,
    // A command the engine ran is deterministic evidence by construction. A
    // `human` check never reaches this function (see `checks.ts`): it is
    // satisfied only through an Approval, so nothing can self-certify by
    // claiming `reviewer.kind = "human"` here.
    reviewer: { kind: "deterministic" },
    caveats,
    provenance: [],
    supersedesId: subject.supersedesId ?? null,
  };
}
