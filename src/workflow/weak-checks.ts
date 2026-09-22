/**
 * Trivially-passing ("weak") check detection (issue #44; PLAN §2.3, §7;
 * `test/spec/gates.spec.md` §B5).
 *
 * A task's *description* of its checks is untrusted text. The only thing that
 * counts is what the check command actually runs. A check whose command is
 * `true`, `exit 0`, `:`, `/bin/true`, `echo ok`, `cd x && true` — or is empty
 * — passes unconditionally and therefore verifies nothing, however
 * convincingly its `rationale` describes end-to-end coverage.
 *
 * The spec already required this (`check_trivial` at `task-ready`); until #44
 * nothing implemented it, so a plan whose single check was `true` reached
 * `ready` and could reach `done` with every guard honestly satisfied. This
 * module is that missing rule, expressed once and consumed by
 * `plan-schema.ts` (`taskReadiness`, plan validation) and `state.ts`
 * (`hasExecutableCheck`, hence the `checks_registered` structural guard), so
 * there is no code path that treats a weak check as verification.
 *
 * Pure: no I/O, no clock, no Jev. Deliberately conservative — it flags only
 * commands that cannot fail, never a command it merely dislikes.
 */

/** Blocker recorded on a task whose only checks pass unconditionally (#44). */
export const WEAK_CHECK_BLOCKER = "weak_check" as const;

/** Check kinds whose `command` is actually executed by the deterministic gate. */
const EXECUTED_KINDS: readonly string[] = ["command", "assertion", "lint", "typecheck"];

/** Shape this module needs from either a `PlanCheck` or a `CheckDefinition`. */
export interface CheckLike {
  readonly kind: string;
  readonly command: string;
}

/**
 * Programs that exit 0 no matter what. `:` is the POSIX null utility; `true`
 * and its absolute paths are the same thing; `echo`/`printf` write to stdout
 * and exit 0; `pwd` prints the working directory. None of them can observe a
 * regression.
 */
const ALWAYS_SUCCEEDS = new Set([
  ":",
  "true",
  "/bin/true",
  "/usr/bin/true",
  "echo",
  "printf",
  "pwd",
  "hostname",
  "whoami",
  "sleep",
]);

/** Commands that are pure navigation/setup and assert nothing on their own. */
const NEUTRAL_PROGRAMS = new Set(["cd", "pushd", "popd", "export", "set", "umask"]);

/**
 * Split a command line on the shell operators that sequence commands, so
 * `cd packages/app && true` is judged by its parts. Quoted regions are left
 * alone: a separator inside `"a && b"` is data, not a separator.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/**
 * Does this one segment pass unconditionally?
 *
 * `exit 0` and `exit` are handled explicitly: a nonzero `exit 3` is a check
 * that genuinely fails, so only the success codes are trivial.
 */
export function segmentAlwaysPasses(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length === 0) return true;
  // `VAR=value cmd` — skip leading environment assignments.
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] as string)) tokens.shift();
  if (tokens.length === 0) return true;
  const program = tokens[0] as string;
  if (program === "exit") {
    const code = tokens[1];
    return code === undefined || code === "0";
  }
  if (program === "return") {
    const code = tokens[1];
    return code === undefined || code === "0";
  }
  if (ALWAYS_SUCCEEDS.has(program)) return true;
  if (NEUTRAL_PROGRAMS.has(program)) return true;
  // `test`/`[` with a constant truthy argument, e.g. `test 1 = 1`, `[ -n x ]`.
  if ((program === "test" || program === "[") && tokens.length <= 2) return true;
  return false;
}

/**
 * Is this check trivially passing? `null` when it is a real check.
 *
 * `human` checks are exempt: their `command` is an instruction to a person,
 * not a command line, and their evidence is a recorded human judgement.
 */
export function trivialCheckReason(check: CheckLike): string | null {
  if (!EXECUTED_KINDS.includes(check.kind)) return null;
  const command = check.command;
  if (command.trim().length === 0) {
    return `check command is empty, so it can never fail`;
  }
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return `check command is empty, so it can never fail`;
  if (segments.every(segmentAlwaysPasses)) {
    return `check command ${JSON.stringify(command)} passes unconditionally and verifies nothing`;
  }
  return null;
}

/** Convenience predicate over `trivialCheckReason`. */
export function isTrivialCheck(check: CheckLike): boolean {
  return trivialCheckReason(check) !== null;
}

/**
 * A check that can actually fail: an executed kind with a non-trivial
 * command, or an explicitly required `human` check.
 *
 * This is the single definition of "registered means of verification" that
 * both the plan-time rule and the runtime `checks_registered` guard use.
 */
export function isVerifyingCheck(check: CheckLike & { readonly required?: boolean }): boolean {
  if (EXECUTED_KINDS.includes(check.kind)) return !isTrivialCheck(check);
  return check.kind === "human" && check.required === true;
}

/** Every trivially-passing check in a list, with the reason for each. */
export function trivialChecks(
  checks: readonly CheckLike[],
): readonly { readonly check: CheckLike; readonly reason: string }[] {
  const out: { check: CheckLike; reason: string }[] = [];
  for (const check of checks) {
    const reason = trivialCheckReason(check);
    if (reason !== null) out.push({ check, reason });
  }
  return out;
}
