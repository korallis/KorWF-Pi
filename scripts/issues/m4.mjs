// M4 — Verification, review, recovery (PLAN §8 Stage 4)

const S4 = `
> ### PLAN §8 Stage 4: Verification, review, and recovery
> Evidence capture; task and phase gates; independent review; evidence-gap and test-exercises-requirement evaluators; failure taxonomy; stall detection; bounded recovery; checkpoints.
> **Exit:** unsupported completion is rejected; failures produce bounded recovery or a clear stop.
`;

const GATE = `
> ### PLAN §2.4 Success gate (per task)
> A task reaches \`done\` only when all of the following hold:
> 1. **Deterministic checks pass** — registered commands exit 0 at the exact revision, recorded as evidence.
> 2. **Jev finds no evidence gap** — completion claim is supported by the presented evidence; every acceptance criterion maps to a check or evidence item; tests exercise the requirement rather than something unrelated.
> 3. **Policy-required review passes** — independent coding-model review for change classes the policy specifies; human approval for high-risk classes.
>
> Jev cannot waive (1) or (3). A worker's assertion cannot set \`done\`. A Jev "no gap" result cannot substitute for a failing check.
`;

export default [
  {
    key: "m4-checks-evidence",
    title: "Check registration and evidence capture at exact revision and environment",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:verification"],
    planRef: "§3.F, §2.4 (1)",
    todoRef: "§4 'Check registration per task/project; evidence capture at exact revision and environment'",
    context: `
Checks are the deterministic half of the gate. A check is a registered command (per task, or project-wide like \`npm test\`) that is run in the task's worktree at a specific revision; its result becomes an Evidence record with exit code, stdout/stderr artifacts, command identity, environment fingerprint, and duration. Human checks are a distinct kind that produce Evidence only via an Approval.
`,
    plan: `
> ### PLAN §3.F
> Evidence records exit code, artifacts, command identity, environment, exact revision. Flaky, missing, or unavailable checks are represented explicitly, never as success.
${GATE}${S4}`,
    scope: ["`runCheck(check, {cwd, revision, signal})` → Evidence with status `pass|fail|timeout|unavailable` (command not found), artifacts saved, env fingerprint (node version, OS, relevant env var names — not values).", "Project-wide checks from config merged with task checks.", "Human check kind: creates a pending Approval, never Evidence directly.", "Deadline per check from config; process-tree kill on timeout."],
    deliverables: ["`src/verification/checks.ts`, `src/verification/evidence.ts`."],
    acceptance: ["Evidence.revision equals `git rev-parse HEAD` of the worktree at run time (test mutates repo between runs and asserts different revisions).", "Command not found → `unavailable`, never `pass`.", "Timeout kills children (spawn a `sleep` subtree; assert none remain).", "Secrets never in stored stdout/stderr (redactor applied)."],
    verification: ["`npm test -- verification/checks`"],
    files: ["src/verification/checks.ts", "src/verification/evidence.ts"],
    deps: ["m3-state-machine"],
  },
  {
    key: "m4-task-gate",
    title: "Task gate implementation — worker claims and Jev scores cannot set `done`",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:verification", "risk:high"],
    planRef: "§2.4, docs/gates.md",
    todoRef: "§4 'Task gate implementation (PLAN §2.4)'",
    context: `
Implements the task gate predicate exactly as specified in Stage 1 (\`docs/gates.md\`, \`test/spec/gates.spec.md\`). This is the precondition hook for the \`→ done\` transition. It reads Evidence, Decision (evidence-gap), and Approval records and returns pass/fail with reasons. It has no side-channel: nothing else can move a task to \`done\`.
`,
    plan: `${GATE}
> ### PLAN §3.F
> Required checks are deterministic; Jev cannot waive them.
${S4}`,
    scope: ["`taskGate(taskId)` → `{pass, reasons[]}` evaluating conditions 1–3 against current records at the task's current revision.", "Condition 2 with Jev disabled: requires the deterministic fallback (every acceptance criterion has ≥1 linked passing check) — never skipped.", "Register as the `→ done` precondition in `src/workflow/state.ts`.", "Implement every Given/When/Then in `test/spec/gates.spec.md` as a real test."],
    deliverables: ["`src/verification/task-gate.ts`, `test/unit/verification/task-gate.test.ts`."],
    acceptance: ["All bypass scenarios from the Stage 1 spec are rejected with an audit entry.", "Jev 'no gap' + one failing check → rejected.", "Stale evidence (older revision) → rejected.", "Worker calling `transition(…, 'done')` directly → rejected."],
    verification: ["`npm test -- task-gate`"],
    files: ["src/verification/task-gate.ts"],
    deps: ["m4-checks-evidence", "m1-gates"],
  },
  {
    key: "m4-evidence-evaluators",
    title: "Completion-claim, evidence-gap, and test-exercises-requirement evaluators",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:decisions", "area:verification"],
    planRef: "§2.4 (2), §3.F, §6",
    todoRef: "§4 'Completion-claim, evidence-gap, and test-exercises-requirement evaluators'",
    context: `
The Jev questions behind gate condition 2. Given a task's acceptance criteria, its checks, the evidence, and the worker's completion summary, Jev answers: is the claim supported? which criteria lack evidence? does each test actually exercise the criterion it is linked to? Outcomes are typed with explicit \`unknown\`, and any gap becomes a \`needs_changes\` blocker with the specific criterion named.
`,
    plan: `
> ### PLAN §3.F
> Jev flags unsupported completion claims, evidence gaps, and tests that don't exercise the requirement.
>
> ### PLAN §6
> Question families: completion-claim support; evidence gap; test-exercises-requirement.
${GATE}${S4}`,
    scope: ["Questions: `verify.claimSupported@1` (Choice: supported/unsupported/unknown), `verify.evidenceGap@1` (Noul: list of criteria ids without supporting evidence), `verify.testExercises@1` (Score per (test, criterion) pair).", "Inputs are minimal: criteria text, check commands, test file excerpts (filtered), evidence summaries — never the full diff unless within byte cap.", "Disabled fallback: mapping-only (each criterion must have ≥1 linked passing check); semantic checks report `not_evaluated`.", "Thresholds per risk class from config (conservative defaults; abstain → treat as gap)."],
    deliverables: ["`src/decisions/questions/verify.ts`, `src/verification/evaluate.ts`."],
    acceptance: ["Scenario 3 fixture (test passes but tests something unrelated) → gap flagged naming the criterion (mock Jev).", "Abstention/unknown is treated as a gap, never as pass.", "Every evaluation writes Decision records with raw distributions."],
    verification: ["`npm test -- verification/evaluate`"],
    files: ["src/decisions/questions/verify.ts", "src/verification/evaluate.ts"],
    deps: ["m4-task-gate"],
  },
  {
    key: "m4-review",
    title: "Independent review contexts: findings, severity, disposition, recheck",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:verification", "area:workers"],
    planRef: "§2.4 (3), §3.F, §6",
    todoRef: "§4 'Independent review contexts; findings, severity, disposition, recheck'",
    context: `
Gate condition 3: for change classes the policy names, an independent coding-model review runs in a fresh context that does not see the worker's claims — only the diff, criteria, and evidence. Findings are structured; Jev scores severity; the user or policy sets disposition; fixed findings are rechecked. Until Stage 5 workers exist, the review runs in-process with the structured-output approach.
`,
    plan: `
> ### PLAN §3.F
> Independent review contexts to reduce anchoring on worker claims.
>
> ### PLAN §6
> Question family: review-finding severity.
${GATE}${S4}`,
    scope: ["Review contract: inputs (diff at revision, criteria, evidence summary), output schema (findings[] with location, description, suggested severity).", "Jev `review.severity@1` (Choice: blocker/major/minor/nit/unknown); fallback = model's suggested severity.", "Policy: which risk classes/ownership globs require review (config).", "Disposition: fix / accept-with-reason / reject; blockers must be fixed and rechecked at the new revision."],
    deliverables: ["`src/verification/review.ts`, `src/decisions/questions/review.ts`."],
    acceptance: ["Reviewer prompt contains no worker summary text (test asserts on the built prompt).", "A `blocker` finding prevents the gate until a recheck at a newer revision passes.", "Review requirement is derived from policy, not from the worker's self-assessment."],
    verification: ["`npm test -- review`"],
    files: ["src/verification/review.ts", "src/decisions/questions/review.ts"],
    deps: ["m4-evidence-evaluators"],
  },
  {
    key: "m4-human-approval",
    title: "Human-approval gates for high-risk classes",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:workflow", "area:security", "risk:high"],
    planRef: "§2.4 (3), §2.6, §7 Execution policy",
    todoRef: "§4 'Human-approval gates for high-risk classes'",
    context: `
For tasks or actions classified high-risk (Stage 1 approval classes), an Approval record from a human is required. This issue implements the request/record/expiry/invalidation lifecycle and the UI prompt, honouring non-interactive mode (queue, never hang).
`,
    plan: `
> ### PLAN §7 Execution policy
> High-risk actions (destructive cleanup, deployment, credential access, publishing, remote pushes) require explicit policy/approval regardless of mode.
>
> ### PLAN §5 Approval
> actor, scope, task/plan revision, permitted action, expiry, invalidation.
${S4}`,
    scope: ["`requestApproval(class, scope, taskRevision)` → pending Approval; prompt via Pi UI when interactive; in non-interactive mode, record as queued and continue other work (Stage 6 wires the unattended policy).", "Approval bound to (task id, revision, action); invalid when revision changes, on expiry, or on mode/policy change.", "Gate condition 3 consults Approval records for high-risk classes."],
    deliverables: ["`src/workflow/approvals.ts`, `src/extension/ui/approval-prompt.ts`."],
    acceptance: ["High-risk task cannot pass the gate without a valid Approval (test).", "Approval for revision N is rejected at revision N+1.", "Non-TTY run never blocks waiting for input (test with a timeout)."],
    verification: ["`npm test -- approvals`"],
    files: ["src/workflow/approvals.ts", "src/extension/ui/approval-prompt.ts"],
    deps: ["m4-task-gate", "m1-approval-classes"],
  },
  {
    key: "m4-evidence-invalidation",
    title: "Evidence invalidation after relevant changes",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:verification"],
    planRef: "§3.F",
    todoRef: "§4 'Evidence invalidation after relevant changes'",
    context: `
Evidence is tied to a revision. When the worktree changes after a check passed, that evidence is stale and the task must return to \`verifying\`. Scenario 2 exercises this: a later edit invalidates a check and re-verification runs.
`,
    plan: `
> ### PLAN §3.F
> Evidence invalidated after relevant changes; integrated checks after merges.
${S4}`,
    scope: ["Watcher/compare: on any new commit or dirty change in the worktree, mark Evidence for the previous revision `stale` (kept for history).", "Relevance: project-wide checks are always invalidated; task checks are invalidated when files matching the task's ownership or the check's declared inputs change (conservative: unknown → invalidate).", "Task in `review`/`done`-candidate returns to `verifying` on invalidation."],
    deliverables: ["`src/verification/invalidate.ts`."],
    acceptance: ["Scenario 2 outline steps for invalidation pass in a fixture.", "Stale evidence is never counted by the gate (test).", "Unrelated-file change with a check declaring inputs does not invalidate it; change with undeclared inputs does."],
    verification: ["`npm test -- invalidate`"],
    files: ["src/verification/invalidate.ts"],
    deps: ["m4-task-gate"],
  },
  {
    key: "m4-check-states",
    title: "Flaky, missing, and unavailable checks represented explicitly",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:verification"],
    planRef: "§3.F",
    todoRef: "§4 'Flaky/missing/unavailable checks represented explicitly'",
    context: `
A check that sometimes passes, a check whose command does not exist, or a check that could not run (e.g. needs a service) must show up as exactly that in the board and the gate — never as pass, and never silently dropped.
`,
    plan: `
> ### PLAN §3.F
> Flaky, missing, or unavailable checks are represented explicitly, never as success.
${S4}`,
    scope: ["Flaky detection: configurable rerun policy (e.g. rerun once on fail); pass-after-fail → `flaky` status with both Evidence records linked; flaky ≠ pass for the gate unless policy explicitly allows for that risk class (default: not allowed).", "Missing: task criterion with no linked check → blocker `missing_check`.", "Unavailable: from Stage 4 checks issue; surfaces as a blocker with the reason."],
    deliverables: ["Extensions to `src/verification/checks.ts` and board rendering."],
    acceptance: ["Flaky check blocks the gate under default policy.", "Board shows distinct markers for pass/fail/flaky/missing/unavailable.", "Missing check for a criterion is reported by criterion id."],
    verification: ["`npm test -- check-states`"],
    files: ["src/verification/checks.ts", "src/extension/ui/board.ts"],
    deps: ["m4-checks-evidence", "m3-boards"],
  },
  {
    key: "m4-failure-taxonomy",
    title: "Failure taxonomy (incl. quota/rate-limit), stall detection, and scope-drift detection",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:workflow", "area:decisions"],
    planRef: "§3.G",
    todoRef: "§4 'Failure taxonomy incl. quota/rate-limit; stall and drift detection'",
    context: `
Recovery needs to know what kind of failure occurred. Deterministic classifiers first (exit codes, error strings from the TypeSafe/provider error taxonomy in Stage 1 docs, missing files), then a Jev Choice for the remainder with \`unknown\` allowed. Stall detection watches attempts for repeated approaches, repeated failures, no measurable progress, and edits outside ownership (drift).
`,
    plan: `
> ### PLAN §3.G
> Failure taxonomy: implementation, environment, missing information, dependency, test expectation, service, quota/rate-limit, unknown. Detect repeated approaches, repeated failures, scope drift, no measurable progress.
${S4}`,
    scope: ["`classifyFailure(evidence|error)` → taxonomy class + confidence + rule/decision id.", "Quota/rate-limit detection feeds ModelAvailability (Stage 5) via an event.", "Stall detector over the Attempt/Evidence stream: same check failing N times, same diff hash repeated, tool-call count without file change, files touched outside ownership → typed stall events.", "Jev `failure.classify@1` and `stall.repeatedApproach@1` with deterministic fallbacks."],
    deliverables: ["`src/workflow/failure.ts`, `src/workflow/stall.ts`, `src/decisions/questions/failure.ts`."],
    acceptance: ["Fixture errors for each taxonomy class are classified correctly by rules alone where the class is deterministic (429 → quota, ENOENT → environment).", "Stall fires after N identical failures (N from config) and drift fires on an out-of-ownership write."],
    verification: ["`npm test -- failure stall`"],
    files: ["src/workflow/failure.ts", "src/workflow/stall.ts"],
    deps: ["m4-checks-evidence"],
  },
  {
    key: "m4-recovery",
    title: "Bounded recovery policies and side-effect reconciliation before retry",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:workflow", "risk:high"],
    planRef: "§3.G",
    todoRef: "§4 'Bounded recovery policies; side-effect reconciliation before retry'",
    context: `
Given a failure class and a stall signal, choose a bounded response from a fixed menu. Retry counts and escalation order come from policy; every response is audited; retrying anything that may have had side effects (a command that writes, a network call) first reconciles the observed state.
`,
    plan: `
> ### PLAN §3.G
> Bounded responses: gather evidence, retry, fallback model (D), replan, change worker/profile, request review, ask user, stop. No blind retry of side effects; reconcile uncertain outcomes first.
${S4}`,
    scope: ["Recovery policy table: failure class × attempt number → response; max attempts per task from config; final response is always `ask user` or `stop`.", "Side-effect flag on checks/commands; before retrying a flagged step, run its reconciliation probe (declared with the step) or ask.", "Model fallback and replan responses are hooks implemented in Stages 5 and 3 respectively; here they are invoked via interfaces."],
    deliverables: ["`src/workflow/recovery.ts`, policy defaults in `src/config/defaults.ts`."],
    acceptance: ["A task cannot loop more than the configured max attempts (test).", "Flagged side-effect step is not retried without reconciliation (test with a spy).", "Every recovery decision has an audit row with the rule applied."],
    verification: ["`npm test -- recovery`"],
    files: ["src/workflow/recovery.ts"],
    deps: ["m4-failure-taxonomy"],
  },
  {
    key: "m4-checkpoints",
    title: "Checkpoints and rollback proposals that preserve user changes",
    milestone: "M4",
    labels: ["stage:4", "type:feature", "area:workflow", "risk:high"],
    planRef: "§3.G, §10",
    todoRef: "§4 'Checkpoints and rollback proposals preserving user changes'",
    context: `
Before a worker starts and after each verified step, take a git checkpoint (per the reuse decision on \`git-checkpoint.ts\`). Rollback is proposed, never automatic, and must never discard the user's own uncommitted changes in the main tree.
`,
    plan: `
> ### PLAN §3.G
> Checkpoints and approval policy for rollback; preserve uncommitted user work.
>
> ### PLAN §10
> Cancellation stops dispatch and child execution; worktrees remain recoverable; dirty user changes preserved.
${S4}`,
    scope: ["Checkpoint = commit or ref in the task worktree tagged with attempt id; main tree untouched.", "Rollback proposal: diff summary + what would be lost; requires Approval class `destructive-git`.", "Dirty-tree guard on the user's main tree (reuse decision on `dirty-repo-guard.ts`)."],
    deliverables: ["`src/workflow/checkpoint.ts`."],
    acceptance: ["User's uncommitted change in main tree survives a rollback of a task worktree (test).", "Rollback without Approval is refused.", "Checkpoints are listed in `/korwf review` output (hook for Stage 8)."],
    verification: ["`npm test -- checkpoint`"],
    files: ["src/workflow/checkpoint.ts"],
    deps: ["m4-recovery", "m4-human-approval"],
  },
  {
    key: "m4-tests",
    title: "Stage 4 test suite: false claims, unrelated passing tests, persistent failure, exhausted budgets, cancellation during recovery",
    milestone: "M4",
    labels: ["stage:4", "type:test", "area:verification"],
    planRef: "§8 Stage 4 exit",
    todoRef: "§4 'Tests: false completion claims, unrelated passing tests, persistent failure, exhausted budgets, cancellation during recovery'",
    context: `
Proves the Stage 4 exit criterion: unsupported completion is rejected; failures produce bounded recovery or a clear stop. Integration tests over a fixture repo with the mock Jev transport.
`,
    plan: S4,
    scope: ["False claim: worker summary says done, no evidence → rejected.", "Unrelated passing test (Scenario 3) → needs_changes with criterion named.", "Persistent failure → after max attempts, `stop` with a concise failure report.", "Budget exhausted mid-recovery → hard stop, state resumable.", "Cancellation during recovery → no orphan processes, task `cancelled`, worktree intact."],
    deliverables: ["`test/integration/stage4/*.test.ts`."],
    acceptance: ["All five pass on CI.", "Scenario 3 outline from Stage 1 is fully covered (each assertion mapped to a test)."],
    verification: ["`npm test -- stage4`"],
    files: ["test/integration/stage4/"],
    deps: ["m4-task-gate", "m4-evidence-evaluators", "m4-review", "m4-human-approval", "m4-evidence-invalidation", "m4-check-states", "m4-recovery", "m4-checkpoints"],
  },
];
