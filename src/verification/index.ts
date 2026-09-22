/**
 * Checks, evidence, reviews, task and phase gates (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * `evidence.ts` and `checks.ts` (issue #45) are the first tenants: check
 * registration, execution at the exact revision, and the `Evidence` records
 * the task and phase gate predicates in `docs/gates.md` read. Later issues add
 * reviews and the gates themselves.
 */
export * from "./evidence.ts";
export * from "./checks.ts";
