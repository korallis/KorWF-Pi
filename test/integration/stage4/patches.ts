/**
 * The three repository states of `test/scenarios/03-wrong-test.md`, as real
 * files that real commands really run against (issue #55).
 *
 * Plain CommonJS with `node:assert` on purpose: the fixture repository must
 * not depend on this package's devDependencies or on the author's toolchain,
 * so a check is `node <file>` and nothing else. The suite is then testing the
 * product's behaviour rather than a mocked runner's.
 */

/** `src/routes/orders.js` before the validation exists. */
export const ROUTE_WITHOUT_VALIDATION = `"use strict";
function createOrder(body) {
  return { status: 201, body: { id: 1, items: body.items } };
}
module.exports = { createOrder };
`;

/** `src/routes/orders.js` with the empty-items rejection implemented. */
export const ROUTE_WITH_VALIDATION = `"use strict";
function createOrder(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return { status: 400, body: { error: "empty_order" } };
  }
  return { status: 201, body: { id: 1, items: body.items } };
}
module.exports = { createOrder };
`;

/**
 * Patch #1's test: it passes, it exercises the module, and it says nothing
 * whatever about the acceptance criterion. This is the "unrelated passing
 * test" the Stage 4 exit criterion names.
 */
export const TEST_HAPPY_PATH_ONLY = `"use strict";
const assert = require("node:assert");
const { createOrder } = require("../../src/routes/orders.js");

const ok = createOrder({ items: [{ id: 1 }] });
assert.strictEqual(ok.status, 201);
console.log("1 passing");
`;

/** Patch #2's test: posts `items: []` and asserts 400 / `empty_order`. */
export const TEST_EXERCISES_CRITERION = `"use strict";
const assert = require("node:assert");
const { createOrder } = require("../../src/routes/orders.js");

const empty = createOrder({ items: [] });
assert.strictEqual(empty.status, 400);
assert.deepStrictEqual(empty.body, { error: "empty_order" });

const ok = createOrder({ items: [{ id: 1 }] });
assert.strictEqual(ok.status, 201);
console.log("2 passing");
`;

/** A test that genuinely fails: the criterion is unimplemented. */
export const TEST_FAILS = `"use strict";
const assert = require("node:assert");
const { createOrder } = require("../../src/routes/orders.js");

const empty = createOrder({ items: [] });
assert.strictEqual(empty.status, 400);
console.log("unreachable");
`;

/**
 * A check command that alternates pass/fail at the same revision, driven by a
 * counter file *outside* the repository so the worktree — and therefore the
 * revision — never changes between runs. That is what makes the disagreement
 * a genuine flake rather than two results about two different states.
 */
export function flakyCommand(counterPath: string): string {
  const path = JSON.stringify(counterPath);
  return (
    "node -e " +
    JSON.stringify(
      `const fs=require('fs');const p=${path};` +
        `let n=0;try{n=parseInt(fs.readFileSync(p,'utf8'),10)||0}catch{};` +
        `fs.writeFileSync(p,String(n+1));` +
        `process.exit(n % 2 === 0 ? 1 : 0)`,
    )
  );
}
