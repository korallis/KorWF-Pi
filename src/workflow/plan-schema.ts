/**
 * The planner's output contract (issue #37; PLAN §2.1, §2.2, §2.3, §3.C).
 *
 * A coding model produces a *plan document*: an architecture summary, ordered
 * phases, and tasks with acceptance criteria, ownership, dependencies, risk
 * class and — the point of PLAN §2.3 — **executable verification checks**.
 *
 * Everything here is pure: parsing, structural validation, and dependency
 * graph validation (including cycles) with path-qualified errors. No I/O, no
 * Jev, no Pi imports, no clock. `plan-store.ts` persists the result into
 * `Phase`/`Task` records; `planner.ts` builds the prompt and drives the
 * parse/retry loop.
 *
 * The rule this module exists to enforce in code rather than in a prompt:
 *
 * > "For every task the planner must emit executable checks (test commands,
 * > assertions, lint/type checks, or an explicitly required human check). …
 * > A task with no checks is not `ready`." — PLAN §2.3
 *
 * A plan is still *accepted* when a task has no checks — rejecting the whole
 * document would lose the rest of the planner's work — but such a task is
 * persisted `proposed` with the `no_checks` blocker and `canBecomeReady`
 * returns false for it. There is no flag that turns that off.
 */
import type { CheckDefinition, RiskClass } from "../storage/records.ts";

/** Blocker recorded on a task the planner gave no checks (PLAN §2.3). */
export const NO_CHECKS_BLOCKER = "no_checks" as const;

/** Blocker recorded when a task's expected output cannot fit the model's turn ceiling (#124). */
export const OUTPUT_BUDGET_BLOCKER = "output_budget" as const;

/** Blocker recorded on a task dropped by a later plan revision. */
export const SUPERSEDED_BLOCKER = "superseded" as const;

/** Check kinds the planner may emit. Mirrors `CheckDefinition["kind"]`. */
export const PLAN_CHECK_KINDS = ["command", "assertion", "lint", "typecheck", "human"] as const;
export type PlanCheckKind = (typeof PLAN_CHECK_KINDS)[number];

/** Check kinds that are executed by the deterministic gate rather than by a person. */
export const EXECUTABLE_CHECK_KINDS = ["command", "assertion", "lint", "typecheck"] as const;

export const PLAN_RISK_CLASSES = ["low", "medium", "high"] as const satisfies readonly RiskClass[];

/** Current version of the plan document contract. Bumped when the shape changes. */
export const PLAN_SCHEMA_VERSION = 1 as const;

/** A single validation finding. `severity: "warning"` never rejects the plan. */
export interface PlanIssue {
  /** Dotted/indexed path from the document root, e.g. `tasks[2].checks[0].command`. */
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  /** Stable rule id, so tests and `/korwf` output can refer to a rule. */
  readonly rule: PlanRuleId;
}

/** Stable ids for the structural and graph rules enforced below. */
export type PlanRuleId =
  | "type"
  | "required"
  | "enum"
  | "range"
  | "duplicate_id"
  | "unknown_reference"
  | "self_dependency"
  | "dependency_cycle"
  | "phase_order"
  | "no_checks"
  | "check_shape"
  | "criterion_coverage"
  | "ownership_conflict"
  | "path_shape";

export type { CheckDefinition };
