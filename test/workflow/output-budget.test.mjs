/**
 * #124 AC1: "A task whose expected output exceeds a documented fraction of the model's
 * `maxTokens` is decomposed or flagged at planning time."
 * #124 AC6: "Behaviour holds with Jev disabled (all of the above is deterministic)."
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSUMED_MAX_OUTPUT_TOKENS,
  DECOMPOSE_FRACTION,
  WARN_FRACTION,
  estimateTokens,
  outputBudget,
  outputCeilingBindsFirst,
  planIncrementalSteps,
  sizePlan,
  sizeTaskOutput,
} from "../../src/workflow/output-budget.ts";

/** Every model in the current registry: 16384 output tokens, a far larger context window. */
const REGISTRY_MODEL = { maxTokens: 16_384, contextWindow: 200_000 };

test("AC1: the documented decompose fraction is of maxTokens, not the context window", () => {
  const budget = outputBudget(REGISTRY_MODEL);
  assert.equal(budget.maxTokens, 16_384);
  assert.equal(budget.decomposeAbove, Math.floor(16_384 * DECOMPOSE_FRACTION));
  assert.equal(budget.warnAbove, Math.floor(16_384 * WARN_FRACTION));
  assert.ok(budget.decomposeAbove < REGISTRY_MODEL.contextWindow / 10);
});

test("AC1: the output ceiling binds before the context window for a registry model", () => {
  assert.equal(outputCeilingBindsFirst(REGISTRY_MODEL), true);
  // Two tasks identical in context need but different in output size get different
  // verdicts — sizing on contextWindow alone cannot distinguish them.
  const small = sizeTaskOutput([{ path: "a.ts", estimate: { unit: "lines", value: 40 } }], REGISTRY_MODEL);
  const large = sizeTaskOutput([{ path: "b.ts", estimate: { unit: "lines", value: 1200 } }], REGISTRY_MODEL);
  assert.equal(small.verdict, "fits");
  assert.equal(large.verdict, "decompose");
});

test("AC1: an artifact above the documented fraction is decomposed into concrete steps", () => {
  const artifact = { path: "docs/gates.md", estimate: { unit: "tokens", value: 20_000 } };
  const sizing = sizeTaskOutput([artifact], REGISTRY_MODEL);
  assert.equal(sizing.verdict, "decompose");
  assert.equal(sizing.mustDecompose, true);
  const [only] = sizing.artifacts;
  assert.ok(only.suggestedSteps >= 3, `expected >= 3 steps, got ${only.suggestedSteps}`);
  const steps = planIncrementalSteps(artifact, REGISTRY_MODEL);
  assert.equal(steps.length, only.suggestedSteps);
  assert.equal(steps[0].kind, "write");
  for (const s of steps.slice(1)) assert.equal(s.kind, "edit");
  const budget = outputBudget(REGISTRY_MODEL);
  for (const s of steps) assert.ok(s.estimatedOutputTokens <= budget.decomposeAbove);
});

test("AC1: an artifact that cannot be split is flagged rather than silently decomposed", () => {
  const sizing = sizeTaskOutput(
    [{ path: "generated.json", estimate: { unit: "tokens", value: 30_000 }, atomic: true }],
    REGISTRY_MODEL,
  );
  assert.equal(sizing.verdict, "flag");
  assert.equal(sizing.mustDecompose, true);
  assert.match(sizing.artifacts[0].reason, /atomic/);
});

test("AC1: an unreported maxTokens is treated as the conservative floor, not as unlimited", () => {
  const budget = outputBudget({ maxTokens: null, contextWindow: 1_000_000 });
  assert.equal(budget.assumed, true);
  assert.equal(budget.maxTokens, ASSUMED_MAX_OUTPUT_TOKENS);
  const sizing = sizeTaskOutput(
    [{ path: "big.ts", estimate: { unit: "tokens", value: 12_000 } }],
    { maxTokens: null, contextWindow: 1_000_000 },
  );
  assert.equal(sizing.verdict, "decompose");
  assert.ok(sizing.notes.some((n) => /Unreported is not unlimited/.test(n)));
});

test("AC1: high thinking reserves output budget, so the same artifact needs decomposing", () => {
  const artifact = { path: "m.ts", estimate: { unit: "tokens", value: 6_000 } };
  assert.equal(sizeTaskOutput([artifact], REGISTRY_MODEL, "off").verdict, "tight");
  const high = sizeTaskOutput([artifact], REGISTRY_MODEL, "high");
  assert.equal(high.verdict, "decompose");
  assert.equal(high.budget.reasoningReserve, 8_192);
  assert.equal(high.budget.usableTokens, 8_192);
});

test("AC1: line and byte estimates convert to output tokens conservatively", () => {
  assert.equal(estimateTokens({ unit: "tokens", value: 10 }), 10);
  assert.ok(estimateTokens({ unit: "lines", value: 100 }) >= 1_000);
  assert.ok(estimateTokens({ unit: "bytes", value: 3_500 }) >= 1_000);
  assert.throws(() => estimateTokens({ unit: "tokens", value: -1 }), /non-negative/);
});

test("AC1: a plan is sized at planning time and over-budget tasks carry step plans", () => {
  const plan = sizePlan(
    [
      { taskId: "T1", expectedArtifacts: [{ path: "small.ts", estimate: { unit: "lines", value: 50 } }] },
      {
        taskId: "T2",
        expectedArtifacts: [
          { path: "huge.ts", estimate: { unit: "lines", value: 2000 } },
          { path: "note.md", estimate: { unit: "lines", value: 20 } },
        ],
      },
    ],
    REGISTRY_MODEL,
  );
  assert.equal(plan.length, 2);
  assert.equal(plan[0].sizing.mustDecompose, false);
  assert.deepEqual(plan[0].decompositions, []);
  assert.equal(plan[1].sizing.mustDecompose, true);
  assert.equal(plan[1].decompositions.length, 1);
  assert.equal(plan[1].decompositions[0].path, "huge.ts");
  assert.ok(plan[1].decompositions[0].steps.length > 1);
});

test("AC6: sizing is deterministic and needs no Jev, key, clock or I/O", () => {
  const artifacts = [
    { path: "a.ts", estimate: { unit: "lines", value: 900 } },
    { path: "b.md", estimate: { unit: "bytes", value: 2_000 } },
  ];
  const first = JSON.stringify(sizeTaskOutput(artifacts, REGISTRY_MODEL, "medium"));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(JSON.stringify(sizeTaskOutput(artifacts, REGISTRY_MODEL, "medium")), first);
  }
  const source = readFileSync(new URL("../../src/workflow/output-budget.ts", import.meta.url), "utf8");
  assert.equal(/\bimport\b/.test(source), false, "output-budget.ts must import nothing");
});
