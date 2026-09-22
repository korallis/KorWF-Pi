/**
 * Data boundaries, privacy defaults, execution policy, secrets (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Public surface of the security module. Credential resolution and the global
 * redactor land here in issue #22; later issues add the data-boundary filters
 * and execution policy alongside them.
 *
 * Import from this index rather than the files directly: the redactor is only
 * effective if every log sink and every error passes through it, and keeping
 * one entry point makes that reviewable.
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./bash-classifier.ts";
export * from "./deny-list.ts";
export * from "./execution-policy.ts";
export * from "./outbound.ts";
export * from "./redact.ts";
export * from "./secrets.ts";
