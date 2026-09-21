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
