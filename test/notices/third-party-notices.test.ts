/**
 * Attribution check for issue #113 (ADR 0001 attribution rule).
 *
 * Acceptance: "a test or lint step fails if a file cites a Pi example in its header but
 * is missing from THIRD_PARTY_NOTICES.md". The first block runs the check against the
 * real repository; the rest build temporary repositories to prove the check actually
 * fails in each defect case (it must not pass vacuously by accident).
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNotices,
  parseHeader,
  HEADER_RE,
} from "../../scripts/check-third-party-notices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const HEADER =
  "Adapted from pi 0.86.1 examples/extensions/dirty-repo-guard.ts — MIT, © Mario Zechner / earendil-works";

describe("THIRD_PARTY_NOTICES.md (repository)", () => {
  it("notices file exists and reproduces the upstream Pi MIT notice verbatim", () => {
    const text = readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(text).toContain("Copyright (c) 2025 Mario Zechner");
    expect(text).toContain(
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    );
    expect(text).toContain("https://github.com/earendil-works/pi");
  });

  it("every file citing a Pi example in its header is listed in THIRD_PARTY_NOTICES.md", () => {
    const result = checkNotices(repoRoot);
    expect(result.errors).toEqual([]);
    // Every listed row must correspond to an attributed file and vice versa.
    expect([...result.listed.keys()].sort()).toEqual(
      [...result.attributed.keys()].sort(),
    );
  });
});

/** Builds a throwaway repo with the real ADR and a notices table containing `rows`. */
function fixture(rows: string[], files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "korwf-notices-"));
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(
    join(root, "docs/adr/0001-reuse-of-pi-examples.md"),
    readFileSync(
      join(repoRoot, "docs/adr/0001-reuse-of-pi-examples.md"),
      "utf8",
    ),
  );
  const table = [
    "<!-- notices:adapted-files:start -->",
    "| File in this repository | Source | Pi version | ADR 0001 row |",
    "|---|---|---|---|",
    ...(rows.length ? rows : ["| _none yet_ | — | — | — |"]),
    "<!-- notices:adapted-files:end -->",
  ].join("\n");
  writeFileSync(
    join(root, "THIRD_PARTY_NOTICES.md"),
    `# Notices\n\n${table}\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const withRow = "| `src/git/status.ts` | `dirty-repo-guard.ts` | 0.86.1 | 7 |";
const attributedFile = `/**\n * ${HEADER}\n */\nexport {};\n`;

describe("attribution check (fixtures)", () => {
  it("passes vacuously when no file is attributed and none is listed", () => {
    const root = fixture([], { "src/git/index.ts": "export {};\n" });
    try {
      expect(checkNotices(root).errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS when a file cites a Pi example but is missing from the notices", () => {
    const root = fixture([], { "src/git/status.ts": attributedFile });
    try {
      const { errors } = checkNotices(root);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /src\/git\/status\.ts cites examples\/extensions\/dirty-repo-guard\.ts .* not listed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes when the attributed file is listed with matching source and version", () => {
    const root = fixture([withRow], { "src/git/status.ts": attributedFile });
    try {
      expect(checkNotices(root).errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS when a listed file has lost its header (stale notice)", () => {
    const root = fixture([withRow], { "src/git/status.ts": "export {};\n" });
    try {
      expect(checkNotices(root).errors[0]).toMatch(
        /carries no ADR 0001 attribution header/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS when the listed Pi version disagrees with the header", () => {
    const root = fixture(
      ["| `src/git/status.ts` | `dirty-repo-guard.ts` | 0.86.0 | 7 |"],
      {
        "src/git/status.ts": attributedFile,
      },
    );
    try {
      expect(checkNotices(root).errors[0]).toMatch(
        /notices list pi 0\.86\.0 but header cites pi 0\.86\.1/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS when the header cites an example outside the ADR 0001 copy manifest", () => {
    const bad = attributedFile.replace("dirty-repo-guard.ts", "todo.ts");
    const root = fixture(["| `src/git/status.ts` | `todo.ts` | 0.86.1 | 4 |"], {
      "src/git/status.ts": bad,
    });
    try {
      expect(checkNotices(root).errors[0]).toMatch(
        /not in the ADR 0001 copy manifest/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognises exactly the ADR 0001 header format", () => {
    expect(parseHeader(`// ${HEADER}\n`)).toEqual({
      version: "0.86.1",
      source: "dirty-repo-guard.ts",
    });
    expect(parseHeader("// Adapted from pi examples, MIT\n")).toBeUndefined();
    expect(
      HEADER_RE.test(
        "Adapted from pi 0.86.0 examples/extensions/subagent/agents.ts — MIT, © Mario Zechner / earendil-works",
      ),
    ).toBe(true);
  });
});
