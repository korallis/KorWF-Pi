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

// ---------------------------------------------------------------------------
// The plan document, exactly as a planner model must emit it
// ---------------------------------------------------------------------------

/** One executable (or explicitly human) check on a task (PLAN §2.3). */
export interface PlanCheck {
  readonly id: string;
  readonly kind: PlanCheckKind;
  /** Exact command line for executable kinds; the instruction for `human`. */
  readonly command: string;
  /** Repository-relative working directory. `.` for the repository root. */
  readonly cwd: string;
  readonly expectedExitCode: number;
  /** Acceptance-criterion ids on the same task that this check exercises. */
  readonly coversCriteria: readonly string[];
  /** `true` when the check may never be waived by Jev or a worker (PLAN §2.4). */
  readonly required: boolean;
  /** Why this check is the right evidence. Free text, kept for the plan document. */
  readonly rationale?: string;
}

/** One acceptance criterion as the planner writes it. */
export interface PlanCriterion {
  readonly id: string;
  readonly text: string;
}

/** An artifact the task is expected to produce, used for output-budget sizing (#124). */
export interface PlanArtifact {
  readonly path: string;
  readonly estimate: {
    readonly unit: "tokens" | "lines" | "bytes";
    readonly value: number;
  };
  /** `true` when the artifact genuinely cannot be produced in pieces. */
  readonly atomic?: boolean;
}

/** A task as the planner emits it. Ids are planner-local, not record ids. */
export interface PlanTask {
  /** Planner-local id, unique within the document (e.g. `t1`). */
  readonly id: string;
  /** Planner-local id of the owning phase. */
  readonly phaseId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly PlanCriterion[];
  readonly checks: readonly PlanCheck[];
  readonly ownership: {
    readonly paths: readonly string[];
    readonly components: readonly string[];
  };
  /** Planner-local task ids that must be done first. Must be acyclic. */
  readonly dependencies: readonly string[];
  readonly riskClass: RiskClass;
  /** Optional; absent means the planner declared no artifacts to size. */
  readonly expectedArtifacts?: readonly PlanArtifact[];
}

/** A phase as the planner emits it. */
export interface PlanPhase {
  readonly id: string;
  /** 0-based position. Must be a dense 0..n-1 sequence over the document. */
  readonly order: number;
  readonly goal: string;
  readonly acceptanceCriteria: readonly PlanCriterion[];
  /** Branch name the phase integrates into; `plan-store.ts` supplies a default. */
  readonly integrationBranch?: string;
}

/** The whole plan document. */
export interface PlanDocument {
  readonly schemaVersion: number;
  /** Prose summary of the architecture the plan assumes or creates (PLAN §2.1). */
  readonly architectureSummary: string;
  readonly phases: readonly PlanPhase[];
  readonly tasks: readonly PlanTask[];
  /** Things the planner could not settle. Surfaced, never silently dropped. */
  readonly openQuestions?: readonly string[];
}

/** Result of validating an unknown value as a `PlanDocument`. */
export type PlanValidation =
  | { readonly ok: true; readonly plan: PlanDocument; readonly warnings: readonly PlanIssue[] }
  | { readonly ok: false; readonly errors: readonly PlanIssue[]; readonly warnings: readonly PlanIssue[] };

// ---------------------------------------------------------------------------
// Small structural helpers
// ---------------------------------------------------------------------------

/** Accumulates path-qualified findings so a caller sees every problem at once. */
class IssueBag {
  readonly errors: PlanIssue[] = [];
  readonly warnings: PlanIssue[] = [];

  error(rule: PlanRuleId, path: string, message: string): void {
    this.errors.push({ rule, path, message, severity: "error" });
  }

  warn(rule: PlanRuleId, path: string, message: string): void {
    this.warnings.push({ rule, path, message, severity: "warning" });
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Require a non-empty trimmed string at `path`. Returns `null` when invalid. */
function requireString(bag: IssueBag, value: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string | null {
  if (value === undefined) {
    bag.error("required", path, `missing required string`);
    return null;
  }
  if (typeof value !== "string") {
    bag.error("type", path, `expected string, got ${typeName(value)}`);
    return null;
  }
  if (opts.allowEmpty !== true && value.trim().length === 0) {
    bag.error("range", path, `must not be empty or whitespace only`);
    return null;
  }
  return value;
}

/** Require an array at `path`. Returns `null` when invalid. */
function requireArray(bag: IssueBag, value: unknown, path: string): readonly unknown[] | null {
  if (value === undefined) {
    bag.error("required", path, `missing required array`);
    return null;
  }
  if (!Array.isArray(value)) {
    bag.error("type", path, `expected array, got ${typeName(value)}`);
    return null;
  }
  return value;
}

function requireInteger(bag: IssueBag, value: unknown, path: string): number | null {
  if (value === undefined) {
    bag.error("required", path, `missing required integer`);
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    bag.error("type", path, `expected integer, got ${typeName(value)}`);
    return null;
  }
  return value;
}

/**
 * Repository-relative path check (PLAN §7: nothing machine-specific is ever
 * persisted). Absolute paths and `..` traversal are structural refusals, not
 * warnings: a plan that owns `/etc` or `../../secrets` is not a plan.
 */
function checkRelativePath(bag: IssueBag, value: string, path: string): void {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    bag.error("path_shape", path, `must be repository-relative, got an absolute path "${value}"`);
    return;
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) {
    bag.error("path_shape", path, `must not traverse outside the repository ("..") : "${value}"`);
  }
}

// ---------------------------------------------------------------------------
// Element validators
// ---------------------------------------------------------------------------

function validateCriteria(bag: IssueBag, raw: unknown, path: string): PlanCriterion[] {
  const items = requireArray(bag, raw, path);
  if (items === null) return [];
  if (items.length === 0) {
    bag.error("range", path, `at least one acceptance criterion is required`);
    return [];
  }
  const seen = new Set<string>();
  const out: PlanCriterion[] = [];
  items.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) {
      bag.error("type", at, `expected object, got ${typeName(item)}`);
      return;
    }
    const id = requireString(bag, item["id"], `${at}.id`);
    const text = requireString(bag, item["text"], `${at}.text`);
    if (id === null || text === null) return;
    if (seen.has(id)) {
      bag.error("duplicate_id", `${at}.id`, `duplicate acceptance-criterion id "${id}"`);
      return;
    }
    seen.add(id);
    out.push({ id, text });
  });
  return out;
}

function validateChecks(bag: IssueBag, raw: unknown, path: string, criterionIds: ReadonlySet<string>): PlanCheck[] {
  const items = requireArray(bag, raw, path);
  if (items === null) return [];
  const seen = new Set<string>();
  const out: PlanCheck[] = [];
  items.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) {
      bag.error("type", at, `expected object, got ${typeName(item)}`);
      return;
    }
    const id = requireString(bag, item["id"], `${at}.id`);
    const kindRaw = item["kind"];
    const command = requireString(bag, item["command"], `${at}.command`);
    if (typeof kindRaw !== "string" || !(PLAN_CHECK_KINDS as readonly string[]).includes(kindRaw)) {
      bag.error("enum", `${at}.kind`, `expected one of ${PLAN_CHECK_KINDS.join(", ")}, got ${JSON.stringify(kindRaw)}`);
      return;
    }
    const kind = kindRaw as PlanCheckKind;
    const cwdRaw = item["cwd"];
    const cwd = cwdRaw === undefined ? "." : requireString(bag, cwdRaw, `${at}.cwd`);
    if (cwd !== null && cwd !== ".") checkRelativePath(bag, cwd, `${at}.cwd`);
    const exitRaw = item["expectedExitCode"];
    const expectedExitCode = exitRaw === undefined ? 0 : requireInteger(bag, exitRaw, `${at}.expectedExitCode`);
    const coversRaw = item["coversCriteria"];
    const covers = coversRaw === undefined ? [] : requireArray(bag, coversRaw, `${at}.coversCriteria`);
    const requiredRaw = item["required"];
    if (requiredRaw !== undefined && typeof requiredRaw !== "boolean") {
      bag.error("type", `${at}.required`, `expected boolean, got ${typeName(requiredRaw)}`);
      return;
    }
    if (id === null || command === null || cwd === null || expectedExitCode === null || covers === null) return;
    if (seen.has(id)) {
      bag.error("duplicate_id", `${at}.id`, `duplicate check id "${id}"`);
      return;
    }
    seen.add(id);

    // An executable check whose "command" is prose is not executable. This is
    // the most common way a model satisfies PLAN §2.3 in appearance only.
    if ((EXECUTABLE_CHECK_KINDS as readonly string[]).includes(kind) && !looksLikeCommand(command)) {
      bag.error(
        "check_shape",
        `${at}.command`,
        `kind "${kind}" needs an executable command line, got prose: ${JSON.stringify(command.slice(0, 60))}`,
      );
      return;
    }

    const coversIds: string[] = [];
    covers.forEach((c, j) => {
      if (typeof c !== "string") {
        bag.error("type", `${at}.coversCriteria[${j}]`, `expected string, got ${typeName(c)}`);
        return;
      }
      if (!criterionIds.has(c)) {
        bag.error("unknown_reference", `${at}.coversCriteria[${j}]`, `no acceptance criterion "${c}" on this task`);
        return;
      }
      coversIds.push(c);
    });

    const rationale = item["rationale"];
    out.push({
      id,
      kind,
      command,
      cwd,
      expectedExitCode,
      coversCriteria: coversIds,
      required: requiredRaw ?? true,
      ...(typeof rationale === "string" ? { rationale } : {}),
    });
  });
  return out;
}

/**
 * Heuristic but deliberately strict: an executable check must start with a
 * token that could be a program (no spaces before it, not a sentence). A
 * description like "run the tests and make sure they pass" is rejected so the
 * deterministic gate is never handed something it cannot run.
 */
function looksLikeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z0-9._/\\$-]+$/.test(first)) return false;
  // A trailing sentence period or a capitalised English sentence opener is prose.
  if (/[.!?]$/.test(trimmed) && !/\.(sh|mjs|cjs|js|ts|py)$/.test(trimmed)) return false;
  // `make` and `check` are real programs, so they are not in this list; the
  // openers here cannot begin a command line in any toolchain.
  return !/^(please|ensure|confirm|review|the|a|an|it|we|you|this|that|someone)$/i.test(first);
}

function validatePhases(bag: IssueBag, raw: unknown): PlanPhase[] {
  const items = requireArray(bag, raw, "phases");
  if (items === null) return [];
  if (items.length === 0) {
    bag.error("range", "phases", `a plan must contain at least one phase`);
    return [];
  }
  const seen = new Set<string>();
  const out: PlanPhase[] = [];
  items.forEach((item, i) => {
    const at = `phases[${i}]`;
    if (!isRecord(item)) {
      bag.error("type", at, `expected object, got ${typeName(item)}`);
      return;
    }
    const id = requireString(bag, item["id"], `${at}.id`);
    const goal = requireString(bag, item["goal"], `${at}.goal`);
    const order = requireInteger(bag, item["order"], `${at}.order`);
    const criteria = validateCriteria(bag, item["acceptanceCriteria"], `${at}.acceptanceCriteria`);
    if (id === null || goal === null || order === null) return;
    if (order < 0) {
      bag.error("range", `${at}.order`, `must be >= 0, got ${order}`);
      return;
    }
    if (seen.has(id)) {
      bag.error("duplicate_id", `${at}.id`, `duplicate phase id "${id}"`);
      return;
    }
    seen.add(id);
    const branch = item["integrationBranch"];
    out.push({
      id,
      order,
      goal,
      acceptanceCriteria: criteria,
      ...(typeof branch === "string" && branch.trim().length > 0 ? { integrationBranch: branch } : {}),
    });
  });

  // Phase order must be a dense 0..n-1 sequence: a gap or a duplicate means
  // the planner's ordering is ambiguous, and `run <phase>` would be too.
  const orders = out.map((p) => p.order).sort((a, b) => a - b);
  orders.forEach((value, index) => {
    if (value !== index) {
      bag.error(
        "phase_order",
        "phases",
        `phase order must be a dense 0..${out.length - 1} sequence; got [${orders.join(", ")}]`,
      );
    }
  });
  return out;
}

function validateArtifacts(bag: IssueBag, raw: unknown, path: string): PlanArtifact[] | undefined {
  if (raw === undefined) return undefined;
  const items = requireArray(bag, raw, path);
  if (items === null) return undefined;
  const out: PlanArtifact[] = [];
  items.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) {
      bag.error("type", at, `expected object, got ${typeName(item)}`);
      return;
    }
    const p = requireString(bag, item["path"], `${at}.path`);
    const estimate = item["estimate"];
    if (p === null) return;
    checkRelativePath(bag, p, `${at}.path`);
    if (!isRecord(estimate)) {
      bag.error("type", `${at}.estimate`, `expected object, got ${typeName(estimate)}`);
      return;
    }
    const unit = estimate["unit"];
    const value = estimate["value"];
    if (unit !== "tokens" && unit !== "lines" && unit !== "bytes") {
      bag.error("enum", `${at}.estimate.unit`, `expected tokens|lines|bytes, got ${JSON.stringify(unit)}`);
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      bag.error("range", `${at}.estimate.value`, `expected a non-negative finite number, got ${typeName(value)}`);
      return;
    }
    const atomic = item["atomic"];
    out.push({ path: p, estimate: { unit, value }, ...(atomic === true ? { atomic: true } : {}) });
  });
  return out;
}

function validateTasks(bag: IssueBag, raw: unknown, phaseIds: ReadonlySet<string>): PlanTask[] {
  const items = requireArray(bag, raw, "tasks");
  if (items === null) return [];
  if (items.length === 0) {
    bag.error("range", "tasks", `a plan must contain at least one task`);
    return [];
  }
  const seen = new Set<string>();
  const out: PlanTask[] = [];
  items.forEach((item, i) => {
    const at = `tasks[${i}]`;
    if (!isRecord(item)) {
      bag.error("type", at, `expected object, got ${typeName(item)}`);
      return;
    }
    const id = requireString(bag, item["id"], `${at}.id`);
    const phaseId = requireString(bag, item["phaseId"], `${at}.phaseId`);
    const goal = requireString(bag, item["goal"], `${at}.goal`);
    const criteria = validateCriteria(bag, item["acceptanceCriteria"], `${at}.acceptanceCriteria`);
    const criterionIds = new Set(criteria.map((c) => c.id));
    const checks = validateChecks(bag, item["checks"], `${at}.checks`, criterionIds);
    const riskRaw = item["riskClass"];
    if (typeof riskRaw !== "string" || !(PLAN_RISK_CLASSES as readonly string[]).includes(riskRaw)) {
      bag.error("enum", `${at}.riskClass`, `expected one of ${PLAN_RISK_CLASSES.join(", ")}, got ${JSON.stringify(riskRaw)}`);
      return;
    }
    const ownershipRaw = item["ownership"];
    const ownership = validateOwnership(bag, ownershipRaw, `${at}.ownership`);
    const depsRaw = item["dependencies"];
    const deps = depsRaw === undefined ? [] : requireArray(bag, depsRaw, `${at}.dependencies`);
    const artifacts = validateArtifacts(bag, item["expectedArtifacts"], `${at}.expectedArtifacts`);
    if (id === null || phaseId === null || goal === null || ownership === null || deps === null) return;
    if (seen.has(id)) {
      bag.error("duplicate_id", `${at}.id`, `duplicate task id "${id}"`);
      return;
    }
    seen.add(id);
    if (!phaseIds.has(phaseId)) {
      bag.error("unknown_reference", `${at}.phaseId`, `no phase with id "${phaseId}" in this plan`);
      return;
    }

    const dependencies: string[] = [];
    deps.forEach((d, j) => {
      if (typeof d !== "string") {
        bag.error("type", `${at}.dependencies[${j}]`, `expected string, got ${typeName(d)}`);
        return;
      }
      if (d === id) {
        bag.error("self_dependency", `${at}.dependencies[${j}]`, `task "${id}" depends on itself`);
        return;
      }
      dependencies.push(d);
    });

    // PLAN §2.3, enforced here rather than in the prompt. The plan is still
    // accepted; `taskReadiness` reports the blocker and plan-store.ts persists
    // the task as `proposed` with `no_checks`.
    if (checks.length === 0) {
      bag.warn(
        "no_checks",
        `${at}.checks`,
        `task "${id}" has no verification checks; it will be persisted as proposed with blocker ` +
          `"${NO_CHECKS_BLOCKER}" and can never become ready (PLAN §2.3)`,
      );
    } else {
      const covered = new Set(checks.flatMap((c) => c.coversCriteria));
      for (const criterion of criteria) {
        if (!covered.has(criterion.id)) {
          bag.warn(
            "criterion_coverage",
            `${at}.acceptanceCriteria`,
            `acceptance criterion "${criterion.id}" on task "${id}" is not covered by any check`,
          );
        }
      }
    }

    out.push({
      id,
      phaseId,
      goal,
      acceptanceCriteria: criteria,
      checks,
      ownership,
      dependencies,
      riskClass: riskRaw as RiskClass,
      ...(artifacts === undefined ? {} : { expectedArtifacts: artifacts }),
    });
  });
  return out;
}

function validateOwnership(bag: IssueBag, raw: unknown, path: string): PlanTask["ownership"] | null {
  if (raw === undefined) {
    bag.error("required", path, `missing required object with paths[] and components[]`);
    return null;
  }
  if (!isRecord(raw)) {
    bag.error("type", path, `expected object, got ${typeName(raw)}`);
    return null;
  }
  const paths = requireArray(bag, raw["paths"], `${path}.paths`);
  const componentsRaw = raw["components"];
  const components = componentsRaw === undefined ? [] : requireArray(bag, componentsRaw, `${path}.components`);
  if (paths === null || components === null) return null;
  const outPaths: string[] = [];
  paths.forEach((p, i) => {
    if (typeof p !== "string") {
      bag.error("type", `${path}.paths[${i}]`, `expected string, got ${typeName(p)}`);
      return;
    }
    checkRelativePath(bag, p, `${path}.paths[${i}]`);
    outPaths.push(p);
  });
  const outComponents: string[] = [];
  components.forEach((c, i) => {
    if (typeof c !== "string") {
      bag.error("type", `${path}.components[${i}]`, `expected string, got ${typeName(c)}`);
      return;
    }
    outComponents.push(c);
  });
  return { paths: outPaths, components: outComponents };
}
