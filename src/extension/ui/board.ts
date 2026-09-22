/**
 * Plain-text board renderer shared by `/korwf tasks` and `/korwf phases`
 * (issue #43; PLAN §3.C, §4 UI).
 *
 * Boards are a *view*: everything here reads rows already computed by the
 * command modules and formats them. Nothing in this file touches the store
 * or the state machine, so a board can never mutate anything by construction
 * (issue #43 Scope: "the boards are a VIEW, they must not mutate state").
 *
 * Output is stable and greppable in a non-TTY (no ANSI, no box-drawing that
 * would defeat `grep`/`diff`), which doubles as the only rendering mode for
 * now — a richer `ctx.ui.custom()` component can be layered on top of these
 * same rows later without changing what the rows contain.
 */

export interface BoardColumn {
  readonly header: string;
  /** Left-pad numeric-looking columns right-aligned; everything else left-aligned. */
  readonly align?: "left" | "right";
}

export interface BoardTable {
  readonly title: string;
  readonly columns: readonly BoardColumn[];
  readonly rows: readonly (readonly string[])[];
}

/** Render one table as a plain, fixed-width, grep-stable block of text. */
export function renderBoardTable(table: BoardTable): string {
  const widths = table.columns.map((col, i) =>
    Math.max(col.header.length, ...table.rows.map((row) => (row[i] ?? "").length)),
  );

  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        const align = table.columns[i]?.align ?? "left";
        return align === "right" ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();

  const lines: string[] = [];
  lines.push(table.title);
  if (table.rows.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  lines.push(formatRow(table.columns.map((c) => c.header)));
  lines.push(widths.map((w) => "-".repeat(Math.max(w, 1))).join("  "));
  for (const row of table.rows) {
    lines.push(formatRow(row));
  }
  return lines.join("\n");
}

/** Join multiple sections with a blank line, dropping empty sections. */
export function renderBoardSections(sections: readonly string[]): string {
  return sections.filter((s) => s.trim() !== "").join("\n\n");
}

/**
 * Distinct, greppable markers per check state (issue #51; PLAN §3.F).
 *
 * ASCII rather than glyphs (`board.ts`'s own rule: no rendering that would
 * defeat `grep`/`diff`), and every non-pass state gets its *own* marker so
 * `flaky`/`missing`/`unavailable`/`timeout` can never be told apart from a
 * plain `fail` by a reader skimming the board.
 */
export const CHECK_STATE_MARKERS: Readonly<Record<string, string>> = {
  pass: "PASS",
  fail: "FAIL",
  flaky: "FLAKY",
  missing: "MISSING",
  unavailable: "UNAVAIL",
  timeout: "TIMEOUT",
};

/** Render one check's state as its board marker. Unknown states pass through verbatim. */
export function checkStateMarker(status: string): string {
  return CHECK_STATE_MARKERS[status] ?? status.toUpperCase();
}
