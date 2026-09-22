/**
 * Checks, evidence, reviews, task and phase gates (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * `evidence.ts` and `checks.ts` (issue #45) are the first tenants: check
 * registration, execution at the exact revision, and the `Evidence` records
 * the task and phase gate predicates in `docs/gates.md` read. Later issues add
 * reviews and the gates themselves.
 *
 * **Re-export style: `export *`, deliberately.** Listing symbols explicitly makes a barrel
 * a guaranteed merge conflict between parallel branches; #37-#40 each hand-resolved that in
 * `src/workflow/index.ts`, always by keeping both sides. A real duplicate-name clash still
 * fails the build, which is the outcome worth hearing about.
 */
export * from "./checks.ts";
export * from "./evaluate.ts";
export * from "./evidence.ts";
export * from "./flaky.ts";
export * from "./task-gate.ts";
export * from "./invalidate.ts";
export * from "./review.ts";
