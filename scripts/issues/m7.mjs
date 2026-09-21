// M7 — Memory, compaction, handoffs, adaptive improvements (PLAN §8 Stage 7)

const S7 = `
> ### PLAN §8 Stage 7
> Source-grounded memory; compaction integration; handoff packets; outcome-backed card refinement; proposed instruction/skill diffs (auto-apply last); drift monitoring.
> **Exit:** resumed and handed-off work preserves commitments; routing improves from outcomes; policy changes are reversible.
`;

export default [
  {
    key: "m7-memory",
    title: "Memory classification, source-linked summaries, freshness and supersession",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:memory", "area:decisions"],
    planRef: "§3.H, §5 Memory",
    todoRef: "§7 'Memory classification; source-linked summaries; freshness/supersession'",
    context: `
Workers and the main session produce summaries. Each summary entry is classified (durable decision, temporary observation, open question, superseded assumption, reusable lesson), linked to its source (session entry / evidence / revision), and tracked for freshness so later work does not act on stale claims. Coding models write the text; Jev classifies and checks consistency.
`,
    plan: `
> ### PLAN §3.H
> Classify durable decisions, temporary observations, open questions, superseded assumptions, reusable lessons. Coding models write summaries; Jev assists selection and consistency. Provenance, freshness, supersession, and source revision on entries.
${S7}`,
    scope: ["Memory repo over the Stage 1 record; `supersede(old, new)` links.", "Question `memory.classify@1` (Choice with `unknown`); `memory.consistent@1` (Choice) comparing a new entry against existing durable ones; fallback = `observation` + no consistency check (flagged).", "Freshness: entry stale when its source revision is behind HEAD for files it references."],
    deliverables: ["`src/memory/store.ts`, `src/decisions/questions/memory.ts`."],
    acceptance: ["Every entry has source + revision; unsourced entries are rejected.", "Contradiction with a durable decision is surfaced, not silently stored (mock)."],
    verification: ["`npm test -- memory`"],
    files: ["src/memory/", "src/decisions/questions/memory.ts"],
    deps: ["m6-tests"],
  },
  {
    key: "m7-pins",
    title: "Deterministic pins for mandatory instructions and unresolved commitments",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:memory"],
    planRef: "§3.H",
    todoRef: "§7 'Deterministic pins for mandatory instructions and commitments'",
    context: `
Some things must survive any compaction or handoff no matter what Jev thinks: project instructions (AGENTS.md), the task's acceptance criteria, unresolved approvals, and explicit user commitments ("never touch X"). These are pinned by rule.
`,
    plan: `
> ### PLAN §3.H
> Deterministic pins for required instructions and unresolved commitments.
${S7}`,
    scope: ["Pin sources: project instruction files, task criteria/checks, pending approvals, user exclusions from intake, unresolved open questions.", "Pins are included verbatim in every compaction summary and handoff packet."],
    deliverables: ["`src/memory/pins.ts`."],
    acceptance: ["Compaction/handoff output always contains the pinned set (test with a mock Jev that ranks them lowest)."],
    verification: ["`npm test -- memory/pins`"],
    files: ["src/memory/pins.ts"],
    deps: ["m7-memory"],
  },
  {
    key: "m7-compaction",
    title: "Compaction integration preserving evidence and tool-message validity",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:extension", "area:memory", "risk:high"],
    planRef: "§3.H, docs/compaction.md",
    todoRef: "§7 'Compaction integration preserving evidence and tool-message validity'",
    context: `
Hook Pi's compaction (per \`docs/compaction.md\` and the reuse decision on \`custom-compaction.ts\`). The product contributes a structured summary (pins + classified memory + current task state) and ensures original evidence is never deleted — it lives in the store — while the conversation stays valid (tool call/result pairing preserved per Pi's rules).
`,
    plan: `
> ### PLAN §3.H
> Integrate with Pi compaction without deleting original evidence.
${S7}`,
    scope: ["Compaction hook implementation.", "Summary builder: pins first, then durable decisions, open questions, current task/phase status, links to evidence ids.", "Validation that the post-compaction message list satisfies Pi's pairing rules."],
    deliverables: ["`src/extension/compaction.ts`, `src/memory/summary.ts`."],
    acceptance: ["After compaction, the store still has all Evidence/Decision rows (count compare).", "Post-compaction session passes Pi's validity check (use the SDK/session-format tooling).", "An agent resumed after compaction can answer 'what is the current task and its checks' from the summary alone (test reads only the summary)."],
    verification: ["`npm test -- compaction`"],
    files: ["src/extension/compaction.ts", "src/memory/summary.ts"],
    deps: ["m7-pins"],
  },
  {
    key: "m7-handoff-packets",
    title: "Handoff packets for workers, fallback, and resumed sessions (unified)",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:memory", "area:workers"],
    planRef: "§3.H",
    todoRef: "§7 'Handoff packets for workers, fallback, and resumed sessions'",
    context: `
Stage 5 built the mid-task fallback packet. Generalise it: a new worker starting a task, a substitute model mid-task, and a user resuming a session all receive a packet built from the same source (memory + pins + task state + evidence), rendered for the audience.
`,
    plan: `
> ### PLAN §3.H
> Explicit handoff packets for workers, model fallback (D), and resumed sessions.
${S7}`,
    scope: ["Refactor `src/memory/handoff-packet.ts` to a single builder with audience renderers.", "Resume: on session resume, print a compact packet as a session entry."],
    deliverables: ["Unified `src/memory/handoff-packet.ts`; wiring in workers and session hooks."],
    acceptance: ["All three audiences receive packets containing the pinned set and current criteria/checks.", "Packet passes the outbound filter and secret regex."],
    verification: ["`npm test -- handoff-packet`"],
    files: ["src/memory/handoff-packet.ts"],
    deps: ["m7-pins", "m5-handoff"],
  },
  {
    key: "m7-outcomes",
    title: "ModelOutcome collection, card refinement, and routing improvement measured on a held-out set",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:models", "area:evaluation"],
    planRef: "§3.D layer 4, Bootstrap; §3.I",
    todoRef: "§7 'ModelOutcome collection; card refinement; routing improvement from held-out comparison'",
    context: `
Every completed attempt writes a ModelOutcome (model, profile, result, cost, latency). Cards refine from these (Stage 5 merge logic). This issue closes the loop: collect outcomes automatically and show, on a held-out task set, that selection with outcomes is at least as good as without — otherwise outcomes are not used.
`,
    plan: `
> ### PLAN §3.D Bootstrap
> Measured-outcome data starts empty for every user. Initial cards come from metadata and config; outcome records refine them per user over time, with uncertainty for sparse data.
>
> ### PLAN §3.I
> Question and routing changes evaluated against held-out tasks before promotion.
${S7}`,
    scope: ["Outcome writer on attempt completion.", "Evaluation harness (`src/evaluation/routing.ts`) comparing selection with/without outcomes on replayed decisions.", "Gate: outcomes influence selection only when the harness shows non-regression (config flag set by the harness result, reversible)."],
    deliverables: ["`src/models/outcomes.ts`, `src/evaluation/routing.ts`."],
    acceptance: ["Outcomes are written for success, failure, and interrupted attempts.", "Harness produces a comparison report; a regression sets the flag off."],
    verification: ["`npm test -- outcomes routing`"],
    files: ["src/models/outcomes.ts", "src/evaluation/routing.ts"],
    deps: ["m6-tests", "m5-cards"],
  },
  {
    key: "m7-drift",
    title: "Question/routing version drift monitoring and rollback",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:evaluation", "area:decisions"],
    planRef: "§3.I",
    todoRef: "§7 'Question/routing version drift monitoring and rollback'",
    context: `
When the Jev model version, a question version, or hints version changes, decision distributions can shift. Monitor per-question outcome distributions across versions, alert on drift beyond a threshold, and allow rolling back to the previous question set/hints version by config.
`,
    plan: `
> ### PLAN §3.I
> Question and routing changes evaluated against held-out tasks before promotion; drift detection; simple rollback.
${S7}`,
    scope: ["Per (question id, version, Jev version) rolling stats from Decision records.", "Drift alert into status; `korwf eval drift` report.", "Rollback = config pin to prior versions; registry honours it."],
    deliverables: ["`src/evaluation/drift.ts`."],
    acceptance: ["Synthetic shift in mock responses triggers the alert.", "Pinning a prior question version makes `ask` use it (test)."],
    verification: ["`npm test -- drift`"],
    files: ["src/evaluation/drift.ts"],
    deps: ["m7-outcomes"],
  },
  {
    key: "m7-policy-guard",
    title: "Guard against autonomous weakening of permissions, allowlist, or spending policy",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:security", "risk:high"],
    planRef: "§3.H, §10",
    todoRef: "§7 'Guard against autonomous weakening of permissions, allowlist, or spending policy'",
    context: `
A structural guard: no code path driven by a worker, Jev result, memory proposal, or recovery action can modify the config sections for allowlist, budgets, approvals, or privacy. Config writes from inside the product are limited to an explicit safe subset and audited.
`,
    plan: `
> ### PLAN §3.H
> The system never weakens its own permission, allowlist, or spending policy.
>
> ### PLAN §10
> No action exceeds approved scope, capability, or budget because a model recommended it.
${S7}`,
    scope: ["Config write API with an allowlist of writable keys (e.g. UI preferences, pins by the user via command); everything else read-only at runtime.", "Worker tool-gate denies edits to `.korwf/config.json` and user Pi config paths.", "Audit + alert on any attempt."],
    deliverables: ["`src/security/policy-guard.ts`; wiring in config, tool-gate, proposals."],
    acceptance: ["Worker bash `echo > .korwf/config.json` is blocked and audited.", "Internal API call to change `budgets.*` throws `PolicyImmutable`."],
    verification: ["`npm test -- policy-guard`"],
    files: ["src/security/policy-guard.ts"],
    deps: ["m7-memory", "m5-readonly-enforcement"],
  },
  {
    key: "m7-instruction-diffs",
    title: "Proposed project-instruction/skill diffs for review; opt-in auto-apply for approved low-risk class only; versioned and reversible (last)",
    milestone: "M7",
    labels: ["stage:7", "type:feature", "area:memory", "area:security", "risk:high"],
    planRef: "§3.H",
    todoRef: "§7 'Proposed instruction/skill diffs for review; opt-in auto-apply…' (Last.)",
    context: `
From reusable lessons in memory, the product may propose edits to AGENTS.md or skill files — as diffs for the user to review. Auto-apply is opt-in, limited to an explicitly approved low-risk class (e.g. adding a note, never removing a rule), versioned, and reversible. PLAN says this is the lowest-priority item in the build; do not start before every other M7 issue is closed.
`,
    plan: `
> ### PLAN §3.H
> Proposed project-instruction/skill updates presented as diffs for review; opt-in automatic application only for an explicitly approved low-risk class; versioned and reversible. Lowest priority in the build order. The system never weakens its own permission, allowlist, or spending policy.
${S7}`,
    scope: ["Proposal builder → unified diff + rationale linked to memory entries.", "Class detection: additive-note vs anything else; only additive-note is auto-applicable and only when config opts in.", "Applied changes recorded with a revert command; `korwf revert-instruction <id>`."],
    deliverables: ["`src/memory/proposals.ts`, `src/extension/commands/revert-instruction.ts`."],
    acceptance: ["A diff that removes or weakens any line in AGENTS.md §4 is never auto-applied and is flagged (test).", "Revert restores the exact previous content (hash compare)."],
    verification: ["`npm test -- proposals`"],
    files: ["src/memory/proposals.ts"],
    deps: ["m7-compaction", "m7-handoff-packets", "m7-drift", "m7-policy-guard"],
  },
];
