/**
 * Throwaway probe extension (issue #10): dump Pi's model registry as JSON.
 *
 * Prints, at `session_start`:
 *   - `available`: every entry from `ctx.modelRegistry.getAvailable()`
 *   - `scoped`:    every entry from `ctx.scopedModels` (the `--models` / `enabledModels` scope)
 *   - `active`:    `ctx.model` and `ctx.thinkingLevel`
 *   - `fieldStats`: per-key presence/type counts across `available`, so absent or
 *                   optional fields are visible without reading every entry.
 *
 * Anything that looks like a URL, hostname, key, token, or credential header is
 * redacted before output; provider auth (`getProviderAuth`) is never dumped.
 *
 * Run (no model call is made; the extension shuts pi down after dumping):
 *   PI_OFFLINE=1 pi --mode rpc -e scripts/probe/model-registry.ts </dev/null 2>/tmp/model-registry.json
 * or set `KORWF_PROBE_OUT=/path/to/file.json` to write the dump to a file instead of stderr.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REDACTED = "<redacted>";

/** Keys whose values are always redacted, whatever they contain. */
const SENSITIVE_KEYS = /^(baseUrl|base_url|url|endpoint|host|hostname|apiKey|api_key|key|token|secret|authorization|headers|env|auth)$/i;

/** Value patterns that are redacted wherever they occur. */
const SENSITIVE_VALUE = /(https?:\/\/|wss?:\/\/|[a-z0-9-]+\.(ts\.net|local|lan|internal|com|net|io|dev)\b|sk-[A-Za-z0-9]|bearer\s|api[-_]?key|token=)/i;

function redact(value: unknown, depth = 0): unknown {
	if (depth > 12) return "<depth-limit>";
	if (typeof value === "string") {
		return SENSITIVE_VALUE.test(value) ? REDACTED : value;
	}
	if (typeof value === "function") return "<function>";
	if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SENSITIVE_KEYS.test(k) ? (v === undefined ? undefined : REDACTED) : redact(v, depth + 1);
		}
		return out;
	}
	return value;
}

function typeOf(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/** For each key seen on any entry: how many entries carry it and with which JSON types. */
function fieldStats(entries: Record<string, unknown>[]): Record<string, { present: number; types: string[] }> {
	const stats: Record<string, { present: number; types: Set<string> }> = {};
	for (const e of entries) {
		for (const [k, v] of Object.entries(e)) {
			if (v === undefined) continue;
			const s = (stats[k] ??= { present: 0, types: new Set() });
			s.present += 1;
			s.types.add(typeOf(v));
		}
	}
	return Object.fromEntries(
		Object.entries(stats)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, s]) => [k, { present: s.present, types: [...s.types].sort() }]),
	);
}

export default function modelRegistryProbe(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const registry = ctx.modelRegistry as unknown as {
			getAvailable: () => unknown;
		};
		const rawAvailable = registry.getAvailable();
		const getAvailableIsPromise = typeof (rawAvailable as Promise<unknown>)?.then === "function";
		const available = (await rawAvailable) as Record<string, unknown>[];

		const dump = {
			probe: "korwf issue #10 model-registry",
			mode: ctx.mode,
			getAvailableIsPromise,
			counts: { available: available.length, scoped: ctx.scopedModels.length },
			fieldStats: fieldStats(available),
			active: redact({ model: ctx.model, thinkingLevel: ctx.thinkingLevel }),
			scoped: redact(ctx.scopedModels.map((s) => ({ thinkingLevel: s.thinkingLevel, model: s.model }))),
			available: redact(available),
		};

		const json = JSON.stringify(dump, null, 2);
		const outPath = process.env.KORWF_PROBE_OUT;
		if (outPath) {
			writeFileSync(outPath, json + "\n");
		} else {
			process.stderr.write(json + "\n");
		}
		ctx.shutdown();
	});
}
