import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPROVAL_CLASSES, APPROVAL_CLASS_TABLE, CONFIGURABLE_CLASSES, DECISION_ORDER, DEFAULT_APPROVAL_CLASSES,
  HIGH_RISK_CLASSES, MUTATION_CLASSES, NO_AUTO_CLASSES, NOTIFICATION_COMMON_FIELDS, WORKFLOW_MODES,
  classifyAct, isMoreRestrictive, resolveDisposition, validateApprovalClasses,
} from "../../src/workflow/approval-classes.ts";

const schema = JSON.parse(readFileSync(new URL("../../src/config/schema.json", import.meta.url), "utf8"));
const schemaClasses = schema.$defs.Approvals.properties.classes.properties;
const doc = readFileSync(new URL("../../docs/approval-classes.md", import.meta.url), "utf8");

test("AC1: every class has a default for all four modes, in code and in the schema", () => {
  assert.equal(APPROVAL_CLASSES.length, new Set(APPROVAL_CLASSES).size);
  for (const id of APPROVAL_CLASSES) {
    for (const mode of WORKFLOW_MODES) {
      assert.ok(DECISION_ORDER.includes(DEFAULT_APPROVAL_CLASSES[id][mode]), `${id}.${mode}`);
      assert.equal(schemaClasses[id].default[mode], DEFAULT_APPROVAL_CLASSES[id][mode], `schema default ${id}.${mode}`);
    }
  }
  assert.deepEqual(Object.keys(schemaClasses).sort(), [...APPROVAL_CLASSES].sort());
  assert.deepEqual(validateApprovalClasses(DEFAULT_APPROVAL_CLASSES), []);
});

test("AC1: the issue's example classes are all represented", () => {
  const covered = {
    "add-dependency": "add_dependency", "modify-config-file": "modify_project_config", "delete-file": "delete_file",
    "run-migration": "run_migration", "network-access": "network_access", "spend-over-estimate": "spend_over_estimate",
    "scope-change": "scope_change", "new-file-outside-ownership": "write_outside_ownership", "remote-push": "remote_push",
    "deploy": "deployment", "credential-access": "credential_access", "destructive-git": "destructive_git",
    "replan": "replan", "model-substitute-more-expensive": "model_substitute_more_expensive",
  };
  for (const id of Object.values(covered)) assert.ok(APPROVAL_CLASSES.includes(id), id);
});

test("AC2: PLAN §7 high-risk classes are `stop` in every mode and cannot be set to `auto` or `queue`", () => {
  for (const req of ["destructive_cleanup", "deployment", "credential_access", "publishing", "destructive_git", "remote_push", "modify_policy"])
    assert.ok(HIGH_RISK_CLASSES.includes(req), req);
  for (const id of HIGH_RISK_CLASSES) {
    assert.equal(schemaClasses[id].$ref, "#/$defs/HighRiskPolicy");
    for (const mode of WORKFLOW_MODES) {
      assert.equal(DEFAULT_APPROVAL_CLASSES[id][mode], "stop");
      assert.deepEqual(schema.$defs.HighRiskPolicy.properties[mode], { const: "stop" });
      for (const weaker of ["auto", "queue"]) {
        const v = validateApprovalClasses({ [id]: { ...DEFAULT_APPROVAL_CLASSES[id], [mode]: weaker } });
        assert.equal(v.length, 1, `${id}.${mode}=${weaker}`);
        assert.equal(v[0].rule, "V10");
        // Defence in depth: even a hand-built weakened table resolves to stop.
        const table = { ...DEFAULT_APPROVAL_CLASSES, [id]: { ...DEFAULT_APPROVAL_CLASSES[id], [mode]: weaker } };
        assert.equal(resolveDisposition(id, mode, table).decision, "stop");
      }
    }
  }
  assert.match(doc, /V10/);
  assert.match(doc, /cannot be set to `auto`/);
});

test("AC2: scope_change and replan are never `auto`; mutation classes are never `auto` in shadow/advisory (V4)", () => {
  for (const id of NO_AUTO_CLASSES) {
    assert.equal(schemaClasses[id].$ref, "#/$defs/NoAutoPolicy");
    for (const mode of WORKFLOW_MODES) {
      assert.notEqual(DEFAULT_APPROVAL_CLASSES[id][mode], "auto");
      assert.deepEqual(schema.$defs.NoAutoPolicy.properties[mode], { enum: ["queue", "stop"] });
      const v = validateApprovalClasses({ [id]: { ...DEFAULT_APPROVAL_CLASSES[id], [mode]: "auto" } });
      assert.equal(v[0]?.rule, "V11");
      assert.equal(resolveDisposition(id, mode, { ...DEFAULT_APPROVAL_CLASSES, [id]: { ...DEFAULT_APPROVAL_CLASSES[id], [mode]: "auto" } }).decision, "queue");
    }
  }
  for (const id of MUTATION_CLASSES.filter((c) => CONFIGURABLE_CLASSES.includes(c))) {
    for (const mode of ["shadow", "advisory"]) {
      assert.notEqual(DEFAULT_APPROVAL_CLASSES[id][mode], "auto", `${id}.${mode}`);
      const v = validateApprovalClasses({ [id]: { ...DEFAULT_APPROVAL_CLASSES[id], [mode]: "auto" } });
      assert.ok(v.some((x) => x.rule === "V4"), `${id}.${mode}`);
    }
  }
  const missing = validateApprovalClasses({ edit_worktree: { shadow: "stop", advisory: "stop", supervised: "queue" } });
  assert.equal(missing[0]?.rule, "V12");
});

test("AC3: Jev may escalate a disposition but never de-escalate it; no Jev ⇒ rules alone", () => {
  assert.match(doc, /Jev may only escalate, never de-escalate/);
  assert.ok(isMoreRestrictive("stop", "queue") && isMoreRestrictive("queue", "auto") && !isMoreRestrictive("auto", "stop"));
  const up = resolveDisposition("edit_worktree", "bounded_autonomous", DEFAULT_APPROVAL_CLASSES, { questionId: "touches_enforcement", proposed: "queue", probability: 0.8 });
  assert.equal(up.ruleDecision, "auto"); assert.equal(up.decision, "queue"); assert.equal(up.jevEscalation?.questionId, "touches_enforcement");
  const down = resolveDisposition("run_shell", "bounded_autonomous", DEFAULT_APPROVAL_CLASSES, { questionId: "looks_harmless", proposed: "auto", probability: 0.99 });
  assert.equal(down.decision, "queue"); assert.equal(down.jevEscalation, null);
  for (const id of HIGH_RISK_CLASSES)
    assert.equal(resolveDisposition(id, "bounded_autonomous", DEFAULT_APPROVAL_CLASSES, { questionId: "q", proposed: "auto", probability: 1 }).decision, "stop");
  const none = resolveDisposition("local_commit", "supervised");
  assert.deepEqual(none, { classId: "local_commit", mode: "supervised", ruleDecision: "queue", decision: "queue", jevEscalation: null });
});

test("classifier: deterministic, most-restrictive-first, judges the act not the label (ADR 0005)", () => {
  const w = { kind: "write", insideWorktree: true, insideOwnership: true, gitTracked: true };
  assert.equal(classifyAct(w), "edit_worktree");
  assert.equal(classifyAct({ ...w, touchesDenyPath: true }), "credential_access");
  assert.equal(classifyAct({ ...w, touchesKorwfPolicy: true }), "modify_policy");
  assert.equal(classifyAct({ ...w, touchesProjectConfig: true }), "modify_project_config");
  assert.equal(classifyAct({ ...w, touchesDependencyManifest: true }), "add_dependency");
  assert.equal(classifyAct({ ...w, insideOwnership: false }), "write_outside_ownership");
  assert.equal(classifyAct({ ...w, insideWorktree: false }), "destructive_cleanup");
  assert.equal(classifyAct({ kind: "delete", insideWorktree: true, insideOwnership: true, gitTracked: true }), "delete_file");
  assert.equal(classifyAct({ kind: "delete", insideWorktree: true, insideOwnership: true, gitTracked: false }), "destructive_cleanup");
  assert.equal(classifyAct({ kind: "git", gitOp: "push", refOwnedByWorkflow: true, remoteIsConfigured: true }), "push_own_branch");
  assert.equal(classifyAct({ kind: "git", gitOp: "push", refOwnedByWorkflow: false, remoteIsConfigured: true }), "remote_push");
  assert.equal(classifyAct({ kind: "git", gitOp: "push", refOwnedByWorkflow: true, remoteIsConfigured: false }), "remote_push");
  assert.equal(classifyAct({ kind: "git", gitOp: "force_push", refOwnedByWorkflow: true }), "destructive_git");
  assert.equal(classifyAct({ kind: "git", gitOp: "tag" }), "publishing");
  assert.equal(classifyAct({ kind: "git", gitOp: "commit" }), "local_commit");
  assert.equal(classifyAct({ kind: "exec", isRegisteredCheck: true }), "run_checks");
  assert.equal(classifyAct({ kind: "exec", isMigration: true, targetIsEphemeral: true }), "run_migration");
  assert.equal(classifyAct({ kind: "exec", isMigration: true, targetIsEphemeral: false }), "deployment");
  assert.equal(classifyAct({ kind: "exec", isInstallOfDeclared: true }), "install_dependencies");
  assert.equal(classifyAct({ kind: "exec" }), "run_shell");
  assert.equal(classifyAct({ kind: "exec", isDeploy: true }), "deployment");
  assert.equal(classifyAct({ kind: "network", hostAllowlisted: false }), "network_access");
  assert.equal(classifyAct({ kind: "model", costDeltaUsd: 0 }), "model_fallback");
  assert.equal(classifyAct({ kind: "model", costDeltaUsd: 0.5 }), "model_substitute_more_expensive");
  assert.equal(classifyAct({ kind: "plan", planOp: "scope_change" }), "scope_change");
  assert.equal(classifyAct({ kind: "plan", planOp: "replan" }), "replan");
  assert.equal(classifyAct({ kind: "task", taskOp: "spend_over_estimate" }), "spend_over_estimate");
  assert.equal(classifyAct({ kind: "task", taskOp: "complete_task" }), "complete_task");
  assert.equal(classifyAct({ kind: "task", taskOp: "spawn_worker" }), "spawn_worker");
  assert.equal(classifyAct({ kind: "read" }), "read_repository");
});

test("doc table mirrors the data table (every class row present with its defaults)", () => {
  for (const c of APPROVAL_CLASS_TABLE) {
    const line = doc.split("\n").find((l) => l.startsWith(`| \`${c.id}\` |`) && l.includes("| Act") === false && l.split("|").length > 9);
    assert.ok(line, `doc row for ${c.id}`);
    const cells = line.split("|").map((s) => s.trim().replaceAll("**", ""));
    assert.deepEqual(cells.slice(4, 8), WORKFLOW_MODES.map((m) => c.defaults[m]), c.id);
  }
});
