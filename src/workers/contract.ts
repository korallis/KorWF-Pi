/**
 * Worker contracts (issue #68; PLAN §3.E "Explicit worker contracts: task,
 * tools, artifacts, budget, model, termination criteria"; ADR 0004).
 *
 * A `WorkerContract` is the whole of what a worker is allowed to be. It is
 * validated **before** anything is spawned: an invalid contract is a refusal,
 * not a degraded launch. In particular `validateContract` re-checks the model
 * against the allowlist here even though `src/models/select.ts` (#60) already
 * enforced it at selection time — the contract may have been persisted,
 * resumed, hand-edited or produced by a different path, and the spawn point is
 * the last place the check can still prevent the request.
 *
 * Validation never widens anything: it can only reject.
 */
import { enforcePolicy } from "../models/select.ts";
import type { ModelAllowlist, ModelRef } from "../config/types.ts";
import { DEFAULT_MAX_DEPTH } from "./env.ts";
import { ROLE_IDS, SPAWN_TOOL_NAMES, isReadOnlyRole, roleTools, type RoleId } from "./roles.ts";

/** Resource inheritance the role explicitly opts into (ADR 0004 row 12). */
export interface ResourceInheritance {
  /** Extension file paths passed with `-e`. Empty by default: `--no-extensions` stands alone. */
  readonly extensions: readonly string[];
  /** Skill paths passed with `--skill`. Empty by default (`--no-skills`). */
  readonly skills: readonly string[];
  /** Load discovered prompt templates? Default false (`--no-prompt-templates`). */
  readonly promptTemplates: boolean;
  /** Load discovered context files (AGENTS.md etc.)? Default false (`--no-context-files`). */
  readonly contextFiles: boolean;
}

/** Bounds the worker must stop within (PLAN §3.E "budget, termination criteria"). */
export interface WorkerBudget {
  readonly wallClockMs: number;
  readonly maxOutputTokens?: number | null;
  readonly maxTotalTokens?: number | null;
  readonly maxSpendUsd?: number | null;
}

/** Termination criteria: how the worker's run is known to be over. */
export interface TerminationCriteria {
  /** Human-readable completion condition, handed to the worker in its prompt. */
  readonly completionStatement: string;
  /** Paths (repo-relative) the worker is expected to produce. May be empty. */
  readonly artifacts: readonly string[];
  /** Milliseconds allowed for the cooperative `abort` before SIGTERM (ADR 0004 tier 2). */
  readonly graceMs: number;
}

/** Everything a worker is permitted to be. */
export interface WorkerContract {
  readonly workerId: string;
  readonly role: RoleId;
  /** The task text. Sent as the first RPC `prompt`, never as argv (ADR 0004). */
  readonly task: string;
  /** Absolute path of the worker's worktree. */
  readonly cwd: string;
  readonly model: ModelRef;
  readonly thinking?: string | null;
  readonly tools: readonly string[];
  readonly budget: WorkerBudget;
  readonly termination: TerminationCriteria;
  readonly inheritance: ResourceInheritance;
  /** Depth of this worker; the orchestrator is 0, its workers are 1. */
  readonly depth: number;
  /** Role needs no network beyond the model endpoint → `PI_OFFLINE=1`. */
  readonly offline: boolean;
  /** Durable session directory for resume, or `null` for `--no-session`. */
  readonly sessionDir: string | null;
}

/** Shipped resource-inheritance default: inherit nothing. */
export const NO_INHERITANCE: ResourceInheritance = Object.freeze({
  extensions: Object.freeze([]) as readonly string[],
  skills: Object.freeze([]) as readonly string[],
  promptTemplates: false,
  contextFiles: false,
});

/** Default budget: 15 minutes of wall clock, no token or spend ceiling declared. */
export const DEFAULT_BUDGET: WorkerBudget = Object.freeze({
  wallClockMs: 15 * 60_000,
  maxOutputTokens: null,
  maxTotalTokens: null,
  maxSpendUsd: null,
});

/** Default grace period between SIGTERM and SIGKILL (ADR 0004 tier 2 → 3). */
export const DEFAULT_GRACE_MS = 3_000;

/** Why a contract was refused. One code per independent invariant. */
export type ContractViolation =
  | "unknown_role"
  | "model_not_in_allowlist"
  | "model_budget_unavailable"
  | "tool_not_allowed_for_role"
  | "spawn_tool_requested"
  | "mutation_tool_for_read_only_role"
  | "depth_exceeds_max"
  | "extension_inheritance_not_permitted"
  | "cwd_not_absolute"
  | "empty_task"
  | "invalid_budget";

/** A single refusal, with a message naming the offending value. */
export interface ContractError {
  readonly code: ContractViolation;
  readonly message: string;
}

/** Result of {@link validateContract}. */
export type ContractValidation =
  | { readonly ok: true; readonly contract: WorkerContract }
  | { readonly ok: false; readonly errors: readonly ContractError[] };

/** Policy inputs the contract is checked against. Supplied by the config layer. */
export interface ContractPolicy {
  readonly allowlist: ModelAllowlist;
  /** `workers.maxDepth`; default 1 (ADR 0004). */
  readonly maxDepth?: number;
  /** Extension paths a role may load with `-e`. Empty by default. */
  readonly permittedExtensions?: readonly string[];
  /** Budget predicate, same shape as #60's: `false` means "no budget for this model". */
  readonly checkBudget?: (ref: ModelRef) => boolean;
}

/**
 * The allowlist question is answered by #60's own `enforcePolicy`, not by a
 * second implementation here: two copies of "is this model permitted" is
 * exactly how a policy quietly widens. The eligible set is `{ref}` because
 * eligibility (route caps, availability) was already decided at selection
 * time; what the spawn point re-checks is the allowlist and the budget.
 */
function modelPermitted(
  ref: ModelRef,
  allowlist: ModelAllowlist,
  checkBudget: ((ref: ModelRef) => boolean) | undefined,
): { readonly ok: boolean; readonly reason: string | null } {
  const check = enforcePolicy(ref, new Set([ref]), allowlist, checkBudget);
  return { ok: check.ok, reason: check.reason };
}

/**
 * Check a contract against the role table and the policy. Returns every
 * violation rather than the first, so a caller can report the whole problem;
 * any violation at all means the worker is not spawned.
 */
export function validateContract(
  contract: WorkerContract,
  policy: ContractPolicy,
): ContractValidation {
  const errors: ContractError[] = [];
  const add = (code: ContractViolation, message: string): void => {
    errors.push({ code, message });
  };

  if (!(ROLE_IDS as readonly string[]).includes(contract.role)) {
    add("unknown_role", `role '${contract.role}' is not one of ${ROLE_IDS.join(", ")}`);
    return { ok: false, errors };
  }

  const modelCheck = modelPermitted(contract.model, policy.allowlist, policy.checkBudget);
  if (!modelCheck.ok) {
    add(
      modelCheck.reason === "budget_unavailable" ? "model_budget_unavailable" : "model_not_in_allowlist",
      `model '${contract.model}' rejected by policy (${modelCheck.reason}); refusing to spawn`,
    );
  }

  const allowed = roleTools(contract.role);
  for (const tool of contract.tools) {
    if ((SPAWN_TOOL_NAMES as readonly string[]).includes(tool)) {
      add("spawn_tool_requested", `tool '${tool}' can start another agent and is never permitted`);
      continue;
    }
    if (!allowed.includes(tool)) {
      add(
        "tool_not_allowed_for_role",
        `tool '${tool}' is not in the '${contract.role}' allowlist (${allowed.join(", ")})`,
      );
    }
  }
  if (isReadOnlyRole(contract.role)) {
    const mutating = contract.tools.filter((t) => !allowed.includes(t));
    for (const tool of mutating) {
      add("mutation_tool_for_read_only_role", `read-only role '${contract.role}' may not use '${tool}'`);
    }
  }

  const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (contract.depth > maxDepth) {
    add("depth_exceeds_max", `depth ${contract.depth} exceeds workers.maxDepth ${maxDepth}`);
  }

  const permitted = policy.permittedExtensions ?? [];
  for (const ext of contract.inheritance.extensions) {
    if (!permitted.includes(ext)) {
      add(
        "extension_inheritance_not_permitted",
        `extension '${ext}' is not in workers.permittedExtensions; workers load --no-extensions`,
      );
    }
  }

  if (!isAbsolutePath(contract.cwd)) {
    add("cwd_not_absolute", `cwd '${contract.cwd}' must be an absolute path to the worker's worktree`);
  }
  if (contract.task.trim() === "") {
    add("empty_task", "contract.task is empty; a worker with no task has no termination criterion");
  }
  if (!(contract.budget.wallClockMs > 0) || !Number.isFinite(contract.budget.wallClockMs)) {
    add("invalid_budget", `budget.wallClockMs must be a positive finite number`);
  }
  if (!(contract.termination.graceMs >= 0) || !Number.isFinite(contract.termination.graceMs)) {
    add("invalid_budget", `termination.graceMs must be a non-negative finite number`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, contract };
}

/** Cross-platform absolute-path test (POSIX `/x`, Windows `C:\x` or `\\unc`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Fields a caller must give; everything else takes a shipped default. */
export interface DraftContract {
  readonly workerId: string;
  readonly role: RoleId;
  readonly task: string;
  readonly cwd: string;
  readonly model: ModelRef;
  readonly thinking?: string | null;
  readonly tools?: readonly string[];
  readonly budget?: Partial<WorkerBudget>;
  readonly termination?: Partial<TerminationCriteria>;
  readonly inheritance?: Partial<ResourceInheritance>;
  readonly depth?: number;
  readonly offline?: boolean;
  readonly sessionDir?: string | null;
}

/**
 * Fill a draft with the shipped defaults. Defaults are the *narrowest*
 * configuration — the role's own tool list, no inherited resources, depth 1,
 * no durable session — so omitting a field can never widen what a worker may
 * do.
 */
export function draftToContract(draft: DraftContract): WorkerContract {
  return {
    workerId: draft.workerId,
    role: draft.role,
    task: draft.task,
    cwd: draft.cwd,
    model: draft.model,
    thinking: draft.thinking ?? null,
    tools: draft.tools ?? roleTools(draft.role),
    budget: { ...DEFAULT_BUDGET, ...draft.budget },
    termination: {
      completionStatement:
        draft.termination?.completionStatement ??
        "Stop when the task's stated deliverables exist and are committed, or report why they cannot be.",
      artifacts: draft.termination?.artifacts ?? [],
      graceMs: draft.termination?.graceMs ?? DEFAULT_GRACE_MS,
    },
    inheritance: { ...NO_INHERITANCE, ...draft.inheritance },
    depth: draft.depth ?? DEFAULT_MAX_DEPTH,
    offline: draft.offline ?? false,
    sessionDir: draft.sessionDir ?? null,
  };
}
