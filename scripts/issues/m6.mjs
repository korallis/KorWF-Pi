// M6 — Parallel orchestration, integration, unattended operation (PLAN §8 Stage 6)

const S6 = `
> ### PLAN §8 Stage 6
> Dependency-aware scheduling; worktrees; ownership/coupling checks; coordinator lock; integration queue; merge-conflict workflow; integrated verification; unattended approval policy; notifications; cost estimate before run; \`run <phase|all>\`.
> **Exit:** independent tasks run concurrently, integrate safely, and a full phase completes unattended within budget.
`;

export default [
  {
    key: "m6-run-command",
    title: "`/korwf run <phase-id | all>` with cost estimate before start",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:extension", "area:workflow"],
    planRef: "§2.1, §2.6, §4 UI",
    todoRef: "§6 'run <phase-id | all>; cost estimate before start'",
    context: `
The second primary command. Validates that the target phase(s) are approved, computes a cost estimate from task profiles and card costs (with \`unknown\` shown honestly), shows it, requires confirmation (or the unattended policy's pre-approval), then starts the scheduler.
`,
    plan: `
> ### PLAN §2.1
> \`/korwf run <phase-id | all> [--mode ...]\` → for each ready task (dependency-aware, parallel where safe): select model → worker executes in worktree → deterministic checks → Jev evidence-gap review → policy-required review / human approval → integrate → done → phase gate → next phase → final report.
>
> ### PLAN §2.6
> A cost estimate before \`run\` begins; a resumable state on any stop.
${S6}`,
    scope: ["Command parsing, phase resolution, approval check (phase must be approved at current revision).", "Estimate: per task expected tokens × card cost; sum with known/estimated/unknown breakdown; compared to budgets; refuse if estimate exceeds cap unless overridden with approval class `spend-over-estimate`.", "Start scheduler (next issue) and print the run id."],
    deliverables: ["`src/extension/commands/run.ts`, `src/workflow/estimate.ts`."],
    acceptance: ["Unapproved phase → refused with reason.", "Estimate over cap → refused unless approved.", "Estimate output distinguishes known/estimated/unknown."],
    verification: ["`npm test -- commands/run estimate`"],
    files: ["src/extension/commands/run.ts", "src/workflow/estimate.ts"],
    deps: ["m5-e2e"],
  },
  {
    key: "m6-scheduler",
    title: "Dependency-aware scheduler: ready-task selection, duplicate-dispatch prevention, concurrency cap",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:workflow", "risk:high"],
    planRef: "§3.E, §3.C",
    todoRef: "§6 'Dependency-aware scheduling; ready-task selection; duplicate-dispatch prevention'",
    context: `
Turns the task graph into a stream of dispatches. Uses the Stage 3 graph utilities, the Stage 5 worker lifecycle, and the global concurrency limit. Must be safe against races (two dispatches of the same task), crashes (resume from store), and cancellation.
`,
    plan: `
> ### PLAN §3.E
> Single-worker, sequential, parallel, and dependency-aware workflows. Enforce concurrency limits.
${S6}`,
    scope: ["Loop: compute ready set; for each, claim via a store transaction (`running` + attempt id) so a duplicate claim fails; dispatch up to the concurrency cap; await completions; re-evaluate.", "Serial constraint from ownership/coupling (next issue) respected.", "Cancellation drains: no new dispatches, running workers cancelled, state resumable."],
    deliverables: ["`src/workflow/scheduler.ts`."],
    acceptance: ["Property test: random DAGs execute in a valid topological order with no task dispatched twice.", "Concurrency never exceeds the cap (counter test).", "Cancel mid-run → all attempts `cancelled`, `run` can be re-invoked and resumes."],
    verification: ["`npm test -- scheduler`"],
    files: ["src/workflow/scheduler.ts"],
    deps: ["m6-run-command", "m3-dependency-graph", "m5-worker-lifecycle"],
  },
  {
    key: "m6-ownership-coupling",
    title: "Worktrees for writing workers; ownership overlap checks; semantic-coupling signal; serial default when uncertain",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:workflow", "area:decisions"],
    planRef: "§3.E",
    todoRef: "§6 'Worktrees for writing workers; ownership overlap checks; semantic-coupling signal; serial default when uncertain'",
    context: `
Two tasks may run in parallel only if their declared ownership does not overlap (code) and Jev does not flag semantic coupling (e.g. both change the same API contract from different files). Unknown → serial.
`,
    plan: `
> ### PLAN §3.E
> Declared ownership conflicts detected in code; Jev adds a semantic-coupling signal; default to serial when coupling is uncertain.
${S6}`,
    scope: ["Ownership overlap via glob intersection.", "Question `tasks.coupling@1` (Choice: independent / coupled / unknown) over task goals + ownership; disabled fallback = `unknown` → serial.", "Scheduler consults a `canRunConcurrently(a, b)` cache."],
    deliverables: ["`src/workflow/coupling.ts`, `src/decisions/questions/coupling.ts`."],
    acceptance: ["Overlapping globs → serial regardless of Jev.", "`unknown` → serial.", "Independent + Jev independent → parallel (scheduler test)."],
    verification: ["`npm test -- coupling`"],
    files: ["src/workflow/coupling.ts", "src/decisions/questions/coupling.ts"],
    deps: ["m6-scheduler", "m5-worktree-guard"],
  },
  {
    key: "m6-coordinator-lock",
    title: "Coordinator lockfile with stale-owner recovery",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:storage", "area:workflow"],
    planRef: "§5",
    todoRef: "§6 'Coordinator lockfile; stale-owner recovery'",
    context: `
Only one coordinator (scheduler) may run per project. Extends the Stage 2 lock with heartbeat and takeover semantics for the scheduler specifically, so a second \`run\` in another Pi session is refused clearly and a crashed coordinator can be replaced.
`,
    plan: `
> ### PLAN §5
> Single writer process, lockfile for coordinator ownership.
${S6}`,
    scope: ["Heartbeat timestamp in the lock; stale after N× interval.", "Second `run` → 'coordinator active in session X since T' and exit.", "Takeover audits the previous owner and triggers attempt reconciliation."],
    deliverables: ["Extensions to `src/storage/lock.ts`, `src/workflow/coordinator.ts`."],
    acceptance: ["Two concurrent `run` invocations: exactly one proceeds.", "Killed coordinator → next `run` takes over after staleness window (fake clock)."],
    verification: ["`npm test -- coordinator`"],
    files: ["src/workflow/coordinator.ts", "src/storage/lock.ts"],
    deps: ["m6-scheduler"],
  },
  {
    key: "m6-integration",
    title: "Single-owner integration queue; base-revision validation; merge-conflict workflow",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:workflow", "area:workers", "risk:high"],
    planRef: "§3.E, §2.1",
    todoRef: "§6 'Single-owner integration queue; base-revision validation; merge-conflict workflow'",
    context: `
Completed task worktrees are integrated into the phase's integration branch by one integrator role, in order, never concurrently. If the worktree's base is behind, rebase/merge; on conflict, run the merge-conflict workflow (per the reuse decision on \`git-merge-and-resolve.ts\`) as a bounded worker task with its own checks; unresolved → block and notify.
`,
    plan: `
> ### PLAN §3.E
> One integration owner; never concurrent uncontrolled integration into the user's tree.
${S6}`,
    scope: ["Integration queue in store; integrator worker processes one item at a time.", "Base-revision check; fast-forward when possible; else merge with conflict detection.", "Conflict resolution as a task (implementer role, restricted to conflicted files) with re-verification.", "Integration branch is `korwf/<workflow>/<phase>`; user's branch untouched until phase gate passes and user approves merge (approval class `merge-to-user-branch`)."],
    deliverables: ["`src/workflow/integrate.ts`."],
    acceptance: ["Two tasks completing simultaneously integrate sequentially (test with a barrier).", "Conflicting edits produce a resolution task; unresolved → phase blocked with notification.", "User's branch HEAD unchanged until explicit approval."],
    verification: ["`npm test -- integrate`"],
    files: ["src/workflow/integrate.ts"],
    deps: ["m6-ownership-coupling", "m6-coordinator-lock"],
  },
  {
    key: "m6-phase-gate",
    title: "Integrated verification, phase gate, and phase report",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:verification", "area:workflow", "risk:high"],
    planRef: "§2.5, docs/gates.md",
    todoRef: "§6 'Integrated verification; phase gate (PLAN §2.5); phase report'",
    context: `
After all tasks in a phase are integrated, run the project-wide checks on the integration branch, ask Jev whether accumulated evidence covers the phase's acceptance criteria, run the policy-required phase review, and produce the phase report. Implements the phase gate predicate from Stage 1.
`,
    plan: `
> ### PLAN §2.5 Phase gate
> Phase done = all tasks done ∧ integrated verification passes on the merged result ∧ Jev finds no gap between phase acceptance criteria and accumulated evidence ∧ policy-required phase review passes. Phase completion produces a report: what was built, evidence, open questions, cost.
${S6}`,
    scope: ["`phaseGate(phaseId)` predicate with the same non-bypass guarantees as the task gate.", "Integrated checks run on the integration branch at its HEAD; evidence recorded at that revision.", "Question `verify.phaseGap@1`; disabled fallback = every phase criterion maps to ≥1 done task with passing evidence.", "Report Markdown written to artifacts and shown."],
    deliverables: ["`src/verification/phase-gate.ts`, `src/workflow/phase-report.ts`."],
    acceptance: ["Bypass scenarios from `test/spec/gates.spec.md` for phases are rejected.", "Report contains: built, evidence list, open questions, cost breakdown (known/estimated/unknown)."],
    verification: ["`npm test -- phase-gate`"],
    files: ["src/verification/phase-gate.ts", "src/workflow/phase-report.ts"],
    deps: ["m6-integration"],
  },
  {
    key: "m6-unattended",
    title: "Unattended approval policy (auto / queue-and-continue / stop) and notifications",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:workflow", "area:security", "risk:high"],
    planRef: "§2.6, docs/approval-classes.md",
    todoRef: "§6 'Unattended approval policy: auto / queue-and-continue / stop; notifications'",
    context: `
Wire the Stage 1 approval-class table and the Stage 4 approval lifecycle into the scheduler so a run can proceed with the user absent: auto-decide pre-approved classes, queue others while continuing independent work, stop the phase for high-risk classes. Every decision is audited and notified.
`,
    plan: `
> ### PLAN §2.6 Unattended operation
> \`run\` may take hours with the user absent. Policy must define, per approval class: Auto-decide; Queue and continue; Stop the phase. Also: notification hooks.
${S6}`,
    scope: ["Policy resolver: (class, mode, config) → disposition; high-risk classes always `stop`.", "Queue: task → `blocked(approval)`, scheduler continues other ready tasks.", "Notification hooks: pluggable sinks (stdout, file, webhook URL from config); payload per class from Stage 1."],
    deliverables: ["`src/workflow/unattended.ts`, `src/telemetry/notify.ts`."],
    acceptance: ["Config attempting to set a high-risk class to `auto` is rejected at load (test).", "Queued approval does not stall independent tasks (scheduler test).", "Stop disposition halts the phase with resumable state and a notification."],
    verification: ["`npm test -- unattended notify`"],
    files: ["src/workflow/unattended.ts", "src/telemetry/notify.ts"],
    deps: ["m6-scheduler", "m4-human-approval", "m0-mode"],
  },
  {
    key: "m6-budget-stops",
    title: "Per-phase and per-workflow budget hard stops; resumable state on any stop",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:telemetry", "area:workflow", "risk:high"],
    planRef: "§2.6",
    todoRef: "§6 'Per-phase and per-workflow budget hard stops; resumable state on any stop'",
    context: `
The ledger (Stage 2) refuses reservations beyond caps; this issue makes the scheduler react correctly: no new dispatches, running workers allowed to finish their current step (or cancelled, per config), phase → \`paused(budget)\`, clear message, and \`run\` resumes cleanly after the user raises the cap.
`,
    plan: `
> ### PLAN §2.6
> Per-phase and per-workflow budget caps with hard stop; a resumable state on any stop.
${S6}`,
    scope: ["Scheduler hooks for `BudgetExceeded`.", "Resume path validates the new cap and continues from the stored state.", "Status shows remaining budget per scope."],
    deliverables: ["Extensions to `src/workflow/scheduler.ts`."],
    acceptance: ["Cap hit mid-phase → `paused(budget)`, no further model calls (spy).", "Raise cap in config → `run` resumes and completes."],
    verification: ["`npm test -- budget-stops`"],
    files: ["src/workflow/scheduler.ts"],
    deps: ["m6-scheduler", "m2-accounting"],
  },
  {
    key: "m6-recoverable-artifacts",
    title: "Recoverable worktrees and artifacts after failure; cleanup policy",
    milestone: "M6",
    labels: ["stage:6", "type:feature", "area:workers", "area:storage"],
    planRef: "§10",
    todoRef: "§6 'Recoverable worktrees/artifacts after failure; cleanup policy'",
    context: `
Failed or cancelled attempts keep their worktree and artifacts so the user or a recovery worker can inspect them. Cleanup is explicit (\`/korwf cleanup\`) or by retention policy, and never removes a worktree with uncommitted changes without approval.
`,
    plan: `
> ### PLAN §10
> Cancellation stops dispatch and child execution; worktrees remain recoverable.
${S6}`,
    scope: ["Retention config; `cleanup` command listing what would be removed; approval class `destructive-cleanup` for dirty worktrees.", "Artifacts manifest links to attempt and evidence."],
    deliverables: ["`src/workers/cleanup.ts`, `src/extension/commands/cleanup.ts`."],
    acceptance: ["Failed attempt's worktree exists after failure and appears in `review`.", "Cleanup of a dirty worktree requires approval; clean ones are removed per retention."],
    verification: ["`npm test -- cleanup`"],
    files: ["src/workers/cleanup.ts", "src/extension/commands/cleanup.ts"],
    deps: ["m6-integration"],
  },
  {
    key: "m6-tests",
    title: "Stage 6 test suite: simultaneous completion, conflicting edits, scheduler crash, partial cancellation, unattended phase (Scenario 1)",
    milestone: "M6",
    labels: ["stage:6", "type:test", "area:workflow"],
    planRef: "§8 Stage 6 exit, §2.8 scenario 1",
    todoRef: "§6 'Tests: simultaneous completion, conflicting edits, scheduler crash, partial cancellation, unattended run to phase completion (scenario 1)'",
    context: `
Proves the Stage 6 exit criterion and Scenario 1 (greenfield phase 1 with two independent tasks in parallel, integration, phase report) with mock Jev and a fake model provider.
`,
    plan: `
> ### PLAN §2.8 Scenario 1
> Greenfield app, phase 1. Plan from a spec; scaffolding + tests; three feature tasks with two independent; parallel execution; integration; phase report.
${S6}`,
    scope: ["Each listed test as an integration test.", "Scenario 1 outline assertions implemented end to end in a temp dir, unattended mode with a pre-approved class set from M0."],
    deliverables: ["`test/integration/stage6/*.test.ts`, `test/integration/scenarios/01-greenfield.test.ts`."],
    acceptance: ["All pass on CI within the configured mock budget.", "Scenario 1 report artifact is produced and checked for required sections."],
    verification: ["`npm test -- stage6 scenarios/01`"],
    files: ["test/integration/stage6/", "test/integration/scenarios/"],
    deps: ["m6-phase-gate", "m6-unattended", "m6-budget-stops", "m6-recoverable-artifacts", "m3-greenfield"],
  },
];
