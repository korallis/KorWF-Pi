/**
 * Pi-TUI components: questionnaire, boards, status widget, dialogs (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Tenants so far:
 * - `board.ts` — the plain-text board renderer shared by `/korwf tasks` and
 *   `/korwf phases` (#43), plus the per-check-state markers from #51.
 * - `approval-prompt.ts` — the human-approval dialog for high-risk classes
 *   (#49). Never blocks without a UI, and never grants anything by itself.
 *
 * **Re-export style: `export *`, deliberately** — the same reasoning as
 * `src/workflow/index.ts`: an explicit list is a guaranteed merge conflict
 * between parallel branches, while a genuine duplicate-name clash still fails
 * the build.
 */
export * from "./board.ts";
export * from "./approval-prompt.ts";
