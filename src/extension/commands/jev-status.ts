/**
 * `/korwf jev` — credential resolution as the user sees it (issue #22).
 *
 * The "key absent ⇒ Jev disabled with one clear message, not an error" path
 * made observable. A pure string builder, so it is tested without a Pi
 * session, and it is the only place that turns a `KeyResolution` into text.
 *
 * It prints the key's *source*, length and fingerprint, never the key.
 */
import type { ConfigLoadResult } from "../../config/index.ts";
import {
  keyDiagnostics,
  resolveJevKey,
  type KeyResolution,
  type SecretsPort,
} from "../../security/index.ts";
import type { KorwfConfig } from "../../config/types.ts";

/** Resolve the key for an already-loaded config. Never throws, never logs. */
export function resolveForConfig(
  config: KorwfConfig,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly secrets?: SecretsPort;
  } = {},
): KeyResolution {
  return resolveJevKey(config, options);
}

/** Human-readable Jev credential status. Contains no credential material. */
export function jevStatusMessage(
  result: ConfigLoadResult,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly secrets?: SecretsPort;
  } = {},
): string {
  if (!result.ok) {
    return [
      result.message,
      "",
      "Jev credential status is unavailable until the configuration loads.",
    ].join("\n");
  }
  const diagnostics = keyDiagnostics(resolveForConfig(result.config, options));
  const lines = [
    `KorWF-Pi — Jev credential status: ${diagnostics.jevEnabled ? "enabled" : "disabled"}`,
    "",
    diagnostics.message,
    "",
    `  key source: ${diagnostics.sourceKind}:${diagnostics.sourceName}`,
  ];
  if (diagnostics.resolvedFromName !== null) {
    lines.push(
      `  resolved from: ${diagnostics.resolvedFromName}${diagnostics.viaFallbackName ? " (documented development fallback name)" : ""}`,
      `  key length: ${String(diagnostics.keyLength)} characters; fingerprint ${String(diagnostics.keyFingerprint)}`,
      "  The key is held in memory only. It is not written to the config, the store, a trace, an artifact, an export, or this message.",
    );
  }
  return lines.join("\n");
}
