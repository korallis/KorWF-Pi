/**
 * Versioned Jev questions and composition policies (issue #27; PLAN §6;
 * docs/adr/0002-source-layout.md, docs/questions.md).
 *
 * This module sits on top of `src/jev/` (transport #24, validation #25) and
 * `src/storage/` (#23) and adds three things:
 *
 * 1. **Question definitions** — `defineNoul` / `defineChoice` / `defineScore`
 *    produce a versioned artefact carrying its prompt, options, minimal
 *    state, interpretation, abstention policy, boundary examples and a
 *    deterministic fallback.
 * 2. **A registry** keyed by `id@version` with a content-hash pin, so text
 *    cannot change without a version bump.
 * 3. **Composition** — `ask` / `askAll` / `askStaged` batch independent
 *    questions and stage dependent ones, recording a Decision on every path,
 *    plus `compose.ts` for combining narrow answers in code.
 *
 * **Re-export style: `export *`, deliberately.** Listing every symbol explicitly makes this
 * barrel a guaranteed merge conflict: four consecutive PRs each appended an export block to
 * `src/workflow/index.ts` and each had to be resolved by hand, always by keeping both.
 * `export *` is additive, so modules added in parallel do not conflict; a genuine
 * duplicate-name clash still fails the build, which is what we want to hear about.
 */
export * from "./ask.ts";
export * from "./cache.ts";
export * from "./compose.ts";
export * from "./examples.ts";
export * from "./question.ts";
export * from "./record.ts";
export * from "./registry.ts";
