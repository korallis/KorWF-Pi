import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TASK_STATES, TASK_TERMINAL_STATES, TASK_NONTERMINAL_STATES, TASK_TRANSITIONS,
  PHASE_STATES, PHASE_TERMINAL_STATES, PHASE_NONTERMINAL_STATES, PHASE_TRANSITIONS,
  PHASE_STORAGE_STATES, PRECONDITIONS, APPROVAL_INVALIDATION_EVENTS,
  INVALIDATION_STATE_EFFECTS, ILLEGAL_TRANSITION_POLICY, TRANSITION_COMMIT_POLICY,
} from "../../src/workflow/transitions.ts";

const taskRows = /** @type {readonly import('../../src/workflow/transitions.ts').Transition<string>[]} */ (TASK_TRANSITIONS);
const phaseRows = /** @type {readonly import('../../src/workflow/transitions.ts').Transition<string>[]} */ (PHASE_TRANSITIONS);
const row = (id) => [...taskRows, ...phaseRows].find((entry) => entry.id === id);
const includesAll = (actual, expected) => expected.forEach((value) => assert.ok(actual.includes(value), `missing ${value}`));
const doc = readFileSync(new URL("../../docs/state-machine.md", import.meta.url), "utf8");

test("AC1: every ready entry, including recovery and cap resume, requires at least one check", () => {
  const ready = taskRows.filter((entry) => entry.to === "ready");
  assert.ok(ready.length >= 2);
  for (const entry of ready) {
    includesAll(entry.preconditions, ["checks_registered", "readiness_valid", "authorization_current"]);
  }
  assert.match(PRECONDITIONS.checks_registered, /Task\.checks\.length >= 1/);
  assert.match(PRECONDITIONS.checks_registered, /explicitly required human check/);
  includesAll(row("task-dispatch").preconditions, ["checks_registered", "dispatch_allowed"]);
});

test("AC2: task done has exactly one engine-only entry with all three non-waivable gates", () => {
  const completion = taskRows.filter((entry) => entry.to === "done");
  assert.equal(completion.length, 1);
  const [entry] = completion;
  assert.equal(entry.id, "task-done");
  assert.deepEqual(entry.from, ["review"]);
  assert.deepEqual(entry.whoMayTrigger, ["engine_only"]);
  assert.deepEqual(entry.preconditions, [
    "checks_registered", "all_checks_pass_exact_revision", "no_jev_gap_or_disabled", "policy_review_satisfied",
  ]);
  assert.match(PRECONDITIONS.all_checks_pass_exact_revision, /current Task\.revision and exact Git SHA/);
  assert.match(PRECONDITIONS.all_checks_pass_exact_revision, /commands exit 0/);
  assert.match(PRECONDITIONS.all_checks_pass_exact_revision, /Missing, stale, flaky, unavailable or nonzero results fail/);
  assert.match(PRECONDITIONS.all_checks_pass_exact_revision, /required=false is not an exemption/);
  assert.match(PRECONDITIONS.policy_review_satisfied, /independent model reviews and high-risk human approvals/);
  assert.equal(TRANSITION_COMMIT_POLICY.writer, "engine_only");
  assert.deepEqual(TRANSITION_COMMIT_POLICY.initialStates, { task: "proposed", phase: "pending" });
  assert.ok(TRANSITION_COMMIT_POLICY.mandatory.some((rule) => rule.includes("raw status-patch") && rule.includes("done")));
});

test("AC2: no-key/disabled Jev is explicit and never waives exact checks or review", () => {
  assert.match(PRECONDITIONS.no_jev_gap_or_disabled, /including no-key mode/);
  assert.match(PRECONDITIONS.no_jev_gap_or_disabled, /recorded deterministic coverage assessment/);
  assert.match(PRECONDITIONS.no_jev_gap_or_disabled, /Missing\/error\/unknown Jev response is not no-gap/);
  assert.match(PRECONDITIONS.no_jev_gap_or_disabled, /Checks and review remain mandatory/);
  includesAll(row("task-stale-evidence").from, ["verifying", "review"]);
  assert.equal(row("task-stale-evidence").to, "verifying");
});

test("AC2: phase done has one engine-only gate on all tasks and exact merged revision", () => {
  const completion = phaseRows.filter((entry) => entry.to === "done");
  assert.equal(completion.length, 1);
  assert.deepEqual(completion[0].from, ["gating"]);
  assert.deepEqual(completion[0].whoMayTrigger, ["engine_only"]);
  assert.deepEqual(completion[0].preconditions, [
    "all_tasks_done", "integrated_checks_pass_exact_revision", "phase_no_jev_gap_or_disabled", "phase_policy_review_satisfied",
  ]);
  assert.match(PRECONDITIONS.integrated_checks_pass_exact_revision, /exact merged Git SHA/);
  assert.match(PRECONDITIONS.all_tasks_done, /cancelled tasks cannot count as done/);
  assert.deepEqual(PHASE_STORAGE_STATES.done, ["passed"]);
  assert.deepEqual(PHASE_STORAGE_STATES.gating, ["integrating", "verifying", "review"]);
});

test("AC3: every nonterminal task and phase has a real outgoing edge; terminals have none", () => {
  for (const [states, terminals, nonterminals, rows] of [
    [TASK_STATES, TASK_TERMINAL_STATES, TASK_NONTERMINAL_STATES, taskRows],
    [PHASE_STATES, PHASE_TERMINAL_STATES, PHASE_NONTERMINAL_STATES, phaseRows],
  ]) {
    assert.deepEqual([...nonterminals].sort(), states.filter((state) => !terminals.includes(state)).sort());
    for (const state of states) {
      const outgoing = rows.filter((entry) => entry.from.includes(state));
      if (terminals.includes(state)) assert.equal(outgoing.length, 0, state);
      else assert.ok(outgoing.some((entry) => entry.to !== state), `no exit from ${state}`);
    }
    // Cancellation alone must not conceal a stuck state: each nonterminal can
    // reach done along the declared graph as well (guards remain mandatory).
    for (const start of nonterminals) {
      const reachable = new Set([start]);
      for (let pass = 0; pass < states.length; pass++) {
        for (const entry of rows) if (entry.from.some((state) => reachable.has(state))) reachable.add(entry.to);
      }
      assert.ok(reachable.has("done"), `no recovery path from ${start}`);
    }
  }
});

test("AC4: every required invalidation event is enumerated with concrete task/phase state effects", () => {
  includesAll(APPROVAL_INVALIDATION_EVENTS.map((entry) => entry.event), [
    "task_revision_changed", "plan_revision_changed", "expired", "mode_changed", "policy_version_changed",
    "consumed", "revoked", "session_reconciled",
  ]);
  assert.equal(new Set(APPROVAL_INVALIDATION_EVENTS.map((entry) => entry.event)).size, APPROVAL_INVALIDATION_EVENTS.length);
  for (const event of APPROVAL_INVALIDATION_EVENTS) {
    assert.ok(event.appliesTo.length > 0);
    assert.ok(event.evidenceEffect.length > 0);
    assert.ok(["blocked", "unchanged_unless_action_repeated"].includes(event.taskEffect));
    assert.ok(["paused", "by_approval_class", "unchanged_unless_action_repeated"].includes(event.phaseEffect));
    if (event.event !== "consumed") assert.equal(event.taskEffect, "blocked");
    assert.ok(doc.includes(`| ${event.event} |`), `undocumented event ${event.event}`);
  }
  assert.deepEqual(row(INVALIDATION_STATE_EFFECTS.task.affectedNonterminal).from, TASK_NONTERMINAL_STATES);
  assert.equal(row(INVALIDATION_STATE_EFFECTS.task.affectedNonterminal).to, "blocked");
  assert.equal(row(INVALIDATION_STATE_EFFECTS.phase.stop_phase).to, "paused");
  assert.equal(INVALIDATION_STATE_EFFECTS.phase.queue_and_continue, "unchanged");
  assert.equal(INVALIDATION_STATE_EFFECTS.task.terminal, "unchanged");
  assert.match(INVALIDATION_STATE_EFFECTS.approval, /never clear/);
});

test("scope: all-capped pause is not failure; auto-resume revalidates and cannot bypass gates", () => {
  assert.match(PRECONDITIONS.all_eligible_models_capped, /nonempty/);
  assert.match(PRECONDITIONS.cap_resume_valid, /no other pause reason remains/);
  assert.match(PRECONDITIONS.cap_resume_valid, /budgets and pins revalidated/);
  assert.equal(row("task-cap").to, "paused_cap");
  assert.equal(row("phase-cap").to, "paused");
  assert.equal(row("task-cap-resume").to, "ready");
  assert.equal(row("phase-cap-resume").to, "running");
  for (const id of ["task-cap-resume", "phase-cap-resume"]) {
    includesAll(row(id).preconditions, ["cap_resume_valid", "authorization_current", "recovery_authorized"]);
    assert.deepEqual(row(id).whoMayTrigger, ["engine_only"]);
  }
  assert.ok(row("phase-cap-resume").requiredEvidence.includes("pause reason all_candidates_capped"));
  assert.ok(row("task-cap").sideEffects.some((effect) => effect.includes("not failed")));
  assert.equal(row("phase-resume").to, "pending");
  assert.deepEqual(row("phase-resume").whoMayTrigger, ["user"]);
});

test("scope: illegal transitions reject without mutation and append an audit record", () => {
  assert.equal(ILLEGAL_TRANSITION_POLICY.disposition, "reject_and_audit");
  includesAll(ILLEGAL_TRANSITION_POLICY.rejects, ["unlisted edge", "unauthorized actor", "false, missing or unknown precondition", "direct status patch", "terminal-state mutation"]);
  assert.match(ILLEGAL_TRANSITION_POLICY.stateEffect, /No task\/phase\/approval\/attempt mutation or external action/);
  includesAll(ILLEGAL_TRANSITION_POLICY.audit, ["requesting actor and engine identity", "unchanged before/after hash", "reason code"]);
  assert.match(ILLEGAL_TRANSITION_POLICY.persistence, /fail closed/);
});

test("scope: a failed integrated gate can retry when tasks are already done", () => {
  assert.equal(row("phase-recover").to, "pending");
  assert.match(PRECONDITIONS.phase_start_valid, /OR all tasks already done and integrated gating needs retry/);
  assert.equal(row("phase-start").to, "running");
  assert.equal(row("phase-gate").to, "gating");
});

test("contract integrity: each edge has guards/evidence/effects/actor, unique identity and known states", () => {
  const ids = new Set();
  for (const [states, rows] of [[TASK_STATES, taskRows], [PHASE_STATES, phaseRows]]) {
    const edges = new Set();
    for (const entry of rows) {
      assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
      ids.add(entry.id);
      assert.ok(states.includes(entry.to));
      assert.ok(entry.from.length && entry.trigger && entry.preconditions.length && entry.requiredEvidence.length && entry.sideEffects.length && entry.whoMayTrigger.length);
      for (const guard of entry.preconditions) assert.ok(Object.hasOwn(PRECONDITIONS, guard), guard);
      for (const actor of entry.whoMayTrigger) assert.ok(["engine_only", "user", "worker_request_then_engine"].includes(actor));
      for (const source of entry.from) {
        assert.ok(states.includes(source), source);
        const key = `${source}/${entry.trigger}`;
        assert.ok(!edges.has(key), `ambiguous trigger ${key}`);
        edges.add(key);
      }
    }
  }
});

test("documentation parity: all transition sources, targets, triggers, actors and guards match data", () => {
  const guardBundles = {
    READY: ["checks_registered", "readiness_valid", "authorization_current"],
    TASK_DONE: ["checks_registered", "all_checks_pass_exact_revision", "no_jev_gap_or_disabled", "policy_review_satisfied"],
    PHASE_DONE: ["all_tasks_done", "integrated_checks_pass_exact_revision", "phase_no_jev_gap_or_disabled", "phase_policy_review_satisfied"],
  };
  const lines = doc.split("\n").filter((line) => /^\| (task|phase)-[a-z-]+;/.test(line));
  assert.equal(lines.length, taskRows.length + phaseRows.length);
  for (const entry of [...taskRows, ...phaseRows]) {
    const matches = lines.filter((line) => line.startsWith(`| ${entry.id};`));
    assert.equal(matches.length, 1, entry.id);
    const cells = matches[0].split("|").slice(1, -1).map((cell) => cell.trim());
    const [source, target] = cells[0].split("; ")[1].split(" → ");
    assert.equal(target, entry.to);
    const sources = source === "T*" ? TASK_NONTERMINAL_STATES : source === "P*" ? PHASE_NONTERMINAL_STATES : source.split(", ");
    assert.deepEqual(sources, entry.from, entry.id);
    const [trigger, actors] = cells[1].split("; ");
    assert.equal(trigger, entry.trigger);
    const actorNames = { E: "engine_only", U: "user", W: "worker_request_then_engine" };
    assert.deepEqual(actors.split(",").map((actor) => actorNames[actor]), entry.whoMayTrigger);
    const guards = cells[2].split("; ").flatMap((guard) => guardBundles[guard] ?? [guard]);
    assert.deepEqual(guards, entry.preconditions, entry.id);
    assert.ok(cells[3].length > 0 && cells[4].length > 0);
  }
});
