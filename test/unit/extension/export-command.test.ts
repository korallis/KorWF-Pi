/**
 * `/korwf export [--plan|--todo] <path>` (issue #43): round-trip coverage —
 * every task id and check command appears in the exported document.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "../../../src/storage/db.ts";
import type { PhaseId, TaskId, WorkflowId } from "../../../src/storage/records.ts";
import { runExport, parseExportArgs } from "../../../src/extension/commands/export.ts";
import { makeTempDir, type TempDir } from "../../helpers/temp-dir.ts";
import { makePhase, makeTask, makeWorkflow } from "../../helpers/records.ts";

const AT = "2026-01-01T00:00:00.000Z";
const WF = "wf-1" as WorkflowId;
const PH = "ph-1" as PhaseId;

const open: { dir: TempDir; store: Store }[] = [];
let counter = 0;

function seededStore(): { store: Store; dir: TempDir } {
  const dir = makeTempDir("korwf-export-cmd-");
  const { store } = openStore({ storageRoot: dir.path, now: () => AT, newId: () => `audit-${(counter += 1)}` });
  open.push({ dir, store });
  store.workflows.insert(makeWorkflow({ id: WF, goal: "Ship the widget" }));
  store.phases.insert(makePhase({ id: PH, workflowId: WF, goal: "Build the widget" }));
  store.tasks.insert(
    makeTask({
      id: "tk-1" as TaskId,
      workflowId: WF,
      phaseId: PH,
      goal: "Write the handler",
      checks: [
        {
          id: "chk-1",
          kind: "command",
          command: "npm test -- handler",
          cwd: ".",
          expectedExitCode: 0,
          coversCriteria: ["ac-1"],
          required: true,
        },
      ],
    }),
  );
  store.tasks.insert(
    makeTask({
      id: "tk-2" as TaskId,
      workflowId: WF,
      phaseId: PH,
      goal: "Write the docs",
      status: "done",
      checks: [
        {
          id: "chk-2",
          kind: "human",
          command: "review the docs read well",
          cwd: ".",
          expectedExitCode: 0,
          coversCriteria: ["ac-1"],
          required: false,
        },
      ],
    }),
  );
  return { store, dir };
}

afterEach(() => {
  while (open.length > 0) {
    const entry = open.pop();
    entry?.store.close();
    entry?.dir.cleanup();
  }
});

describe("AC: export round-trips — exported plan contains every task id and check command", () => {
  it("--plan writes every task id, goal, and check command", () => {
    const { store, dir } = seededStore();
    const outPath = join(dir.path, "out", "PLAN.export.md");
    const outcome = runExport(store, parseExportArgs(["--plan", outPath]) as never);
    expect(outcome.ok).toBe(true);
    const text = readFileSync(outPath, "utf8");
    for (const term of ["tk-1", "tk-2", "npm test -- handler", "review the docs read well", "Write the handler", "Write the docs"]) {
      expect(text).toContain(term);
    }
    rmSync(join(dir.path, "out"), { recursive: true, force: true });
  });

  it("--todo checks off done tasks and lists check ids", () => {
    const { store, dir } = seededStore();
    const outPath = join(dir.path, "out", "TODO.export.md");
    const outcome = runExport(store, parseExportArgs(["--todo", outPath]) as never);
    expect(outcome.ok).toBe(true);
    const text = readFileSync(outPath, "utf8");
    expect(text).toMatch(/- \[ \] `tk-1`/);
    expect(text).toMatch(/- \[x\] `tk-2`/);
    expect(text).toContain("chk-1");
    expect(text).toContain("chk-2");
  });

  it("defaults to --plan when no format flag is given", () => {
    const { store, dir } = seededStore();
    const outPath = join(dir.path, "out", "default.md");
    const parsed = parseExportArgs([outPath]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.format).toBe("plan");
    runExport(store, parsed as never);
  });

  it("rejects missing path with a usage message", () => {
    const parsed = parseExportArgs(["--plan"]);
    expect(parsed.ok).toBe(false);
  });
});
