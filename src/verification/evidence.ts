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
 * The check states of `docs/gates.md` §4, as produced by a *run*.
 *
 * `missing` is deliberately absent: it is the state of a check with no
 * evidence at all, which is a property of the store, not of a run.
 */
export type CheckRunStatus = "pass" | "fail" | "timeout" | "unavailable" | "flaky";

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
