/**
 * Greenfield bootstrap (issue #38; PLAN §2.7).
 *
 * "When no repository exists: initialise version control, produce
 * architecture and scaffolding as phase 0, generate test infrastructure
 * before feature tasks, and treat the plan document itself as the retrieval
 * context until code exists."
 *
 * This module does not reimplement the planner or the plan contract from
 * #37 (`plan-schema.ts`, `planner.ts`). It adds the greenfield-specific
 * planner prompt variant and the extra validation rule #37 doesn't try to
 * enforce on its own: a greenfield plan's Phase 0 must contain the three
 * mandated tasks (repository init, scaffold, test infrastructure) and every
 * later phase must depend on it. `greenfieldScaffoldingIssues` in
 * `planner.ts` already warns when Phase 0 registers no executable check —
 * this module builds on that warning (by reusing it) rather than
 * duplicating its logic.
 *
 * `src/git/` is the only place that runs git (ADR 0002); the actual `git
 * init` a Phase 0 "initialise version control" task performs happens through
 * a worker attempt running that task's check command, not through a call
 * from this module.
 */
import type { PlanDocument, PlanIssue, PlanTask } from "./plan-schema.ts";
import { greenfieldScaffoldingIssues } from "./planner.ts";

// ---------------------------------------------------------------------------
// Mandated Phase 0 tasks
// ---------------------------------------------------------------------------

/** The three roles a greenfield Phase 0 task must fulfil (PLAN §2.7). */
export const GREENFIELD_PHASE0_ROLES = ["repo_init", "scaffold", "test_infra"] as const;
export type GreenfieldPhase0Role = (typeof GREENFIELD_PHASE0_ROLES)[number];

/**
 * A task is recognised as filling a mandated role by an executable check
 * whose command contains the role's signature substring. Matching on the
 * check command — not the task's free-text goal — keeps this deterministic
 * and keeps the same "no prose is executable" discipline #37 uses.
 */
const ROLE_SIGNATURES: Record<GreenfieldPhase0Role, readonly string[]> = {
  repo_init: ["git init", "git -C"],
  scaffold: ["npm init", "npm install", "mkdir", "touch", "npm create", "yarn init", "pnpm init"],
  test_infra: ["test", "vitest", "jest", "mocha", "pytest", "go test"],
};

function taskFillsRole(task: PlanTask, role: GreenfieldPhase0Role): boolean {
  const signatures = ROLE_SIGNATURES[role];
  return task.checks.some((check) => {
    const command = check.command.toLowerCase();
    return signatures.some((sig) => command.includes(sig));
  });
}

export interface GreenfieldPhase0Coverage {
  readonly phaseId: string | null;
  readonly rolesCovered: ReadonlySet<GreenfieldPhase0Role>;
  readonly missingRoles: readonly GreenfieldPhase0Role[];
}

/** Which of the three mandated roles Phase 0 (order 0) actually covers. */
export function phase0Coverage(plan: PlanDocument): GreenfieldPhase0Coverage {
  const phase0 = plan.phases.find((p) => p.order === 0);
  if (phase0 === undefined) {
    return { phaseId: null, rolesCovered: new Set(), missingRoles: [...GREENFIELD_PHASE0_ROLES] };
  }
  const tasks = plan.tasks.filter((t) => t.phaseId === phase0.id);
  const covered = new Set<GreenfieldPhase0Role>();
  for (const role of GREENFIELD_PHASE0_ROLES) {
    if (tasks.some((t) => taskFillsRole(t, role))) covered.add(role);
  }
  const missing = GREENFIELD_PHASE0_ROLES.filter((r) => !covered.has(r));
  return { phaseId: phase0.id, rolesCovered: covered, missingRoles: missing };
}

/**
 * Every feature task (any task outside Phase 0) must depend, directly or
 * transitively through its phase's dependency chain, on Phase 0 having run
 * first. Because phases execute strictly in `order` (enforced by #37's
 * dependency-graph rule that a task may never depend on a later phase),
 * "later phase" already implies "after phase 0" for phases with order >= 1.
 * What this checks instead is the case #37 does not: a feature *task* naming
 * an *explicit* dependency on a Phase 0 task is not required by #37, so this
 * records it as a warning rather than promoting it to a hard error — the
 * phase-ordering guarantee alone is sufficient for correctness, but an
 * explicit dependency is the stronger, auditable statement PLAN §2.7 asks for.
 */
export function featurePhasesDependOnPhase0(plan: PlanDocument): readonly PlanIssue[] {
  const phase0 = plan.phases.find((p) => p.order === 0);
  if (phase0 === undefined) return [];
  const phase0TaskIds = new Set(plan.tasks.filter((t) => t.phaseId === phase0.id).map((t) => t.id));
  if (phase0TaskIds.size === 0) return [];

  const issues: PlanIssue[] = [];
  const laterPhases = plan.phases.filter((p) => p.order > 0);
  for (const phase of laterPhases) {
    const tasksInPhase = plan.tasks.filter((t) => t.phaseId === phase.id);
    for (const task of tasksInPhase) {
      const dependsOnPhase0 = task.dependencies.some((d) => phase0TaskIds.has(d));
      if (!dependsOnPhase0) {
        issues.push({
          rule: "unknown_reference",
          path: `tasks[${plan.tasks.indexOf(task)}].dependencies`,
          severity: "warning",
          message:
            `greenfield: task "${task.id}" in phase "${phase.id}" (order ${phase.order}) declares no explicit ` +
            `dependency on a phase 0 task; phase ordering makes it run after phase 0 regardless, but PLAN §2.7 ` +
            `expects feature phases to depend on the bootstrap explicitly`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------

export const MISSING_PHASE0_ROLE = "greenfield_missing_phase0_role" as const;
export type GreenfieldRuleId = typeof MISSING_PHASE0_ROLE;

/**
 * Validate a plan that `intake.ts`/`resolveRepo` marked greenfield. This is
 * additive to `validatePlanDocument` (#37): it never re-checks structure, and
 * it never rejects a structurally valid plan. A plan missing a mandated
 * Phase 0 role is reported as an **error** here — the deliverable in this
 * issue's acceptance criteria ("Greenfield plan always has Phase 0 with the
 * three mandated tasks") is a hard requirement, unlike the softer
 * dependency-declaration check above.
 */
export function validateGreenfieldPlan(plan: PlanDocument): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  const coverage = phase0Coverage(plan);
  if (coverage.phaseId === null) {
    issues.push({
      rule: "no_checks",
      path: "phases",
      severity: "error",
      message: `greenfield plan has no phase with order 0; PLAN §2.7 requires a bootstrap phase 0`,
    });
  } else if (coverage.missingRoles.length > 0) {
    issues.push({
      rule: "no_checks",
      path: `phases`,
      severity: "error",
      message:
        `greenfield plan phase "${coverage.phaseId}" is missing mandated task(s) for: ` +
        `${coverage.missingRoles.join(", ")} (PLAN \u00a72.7 requires repo init, scaffold, and test infrastructure)`,
    });
  }
  issues.push(...greenfieldScaffoldingIssues(plan));
  issues.push(...featurePhasesDependOnPhase0(plan));
  return issues;
}

/** `true` when every mandated Phase 0 role and every executable-check requirement are met. */
export function isValidGreenfieldPlan(plan: PlanDocument): boolean {
  return validateGreenfieldPlan(plan).every((i) => i.severity !== "error");
}

// ---------------------------------------------------------------------------
// Planner prompt variant (PLAN §2.7)
// ---------------------------------------------------------------------------

/**
 * Additional prompt lines appended to `buildPlannerPrompt`'s output when
 * `intake.greenfield` is true. `planner.ts` already states the greenfield
 * phase-0 rule generically (rule 7 of `planRulesText`); this spells out the
 * three mandated tasks explicitly, in the same vocabulary
 * `validateGreenfieldPlan` checks against, so the planner model is told
 * exactly what will be enforced.
 */
export function greenfieldPromptAddendum(): readonly string[] {
  return [
    "## Greenfield bootstrap (PLAN \u00a72.7 — enforced in code)",
    "",
    "No repository exists yet. Phase 0 (order 0) must contain, at minimum, tasks whose checks cover all three of:",
    "",
    '1. **repo_init** — initialise version control. A check command containing `git init`.',
    '2. **scaffold** — produce architecture and scaffolding: package manifest, directory layout. A check command such as `npm init`, `npm install`, or one that creates the layout.',
    '3. **test_infra** — generate test infrastructure *before* any feature task. A check command that runs or verifies the test runner (contains "test", or a runner name such as `vitest`/`jest`/`pytest`).',
    "",
    "Every feature-phase task should declare an explicit `dependencies` entry on a phase 0 task, not rely on phase ordering alone.",
    "Until code exists, treat the plan/spec document itself as the retrieval context — do not invent files that are not in the goal, the spec, or a clarification.",
  ];
}
