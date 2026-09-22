/**
 * AC: "Original tool output retained in the artifact dir alongside the
 * filtered excerpts" (PLAN §3.B).
 */
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../../src/storage/artifacts.ts";
import { resolveArtifactDir } from "../../../src/storage/paths.ts";
import { makeTempDir } from "../../helpers/temp-dir.ts";
import { toShortlistEntry, writeRawToolOutput, writeShortlist } from "../../../src/context/artifacts.ts";
import { retrieveCandidates } from "../../../src/context/retrieve.ts";
import { rankCandidates } from "../../../src/context/rank.ts";
import { MockJevTransport } from "../../../src/jev/mock.ts";
import type { AskContext } from "../../../src/decisions/ask.ts";
import { buildTestRepo, type TestRepo } from "./support.ts";

describe("context/artifacts.ts", () => {
  it("writes raw tool output and a shortlist manifest, both verifiable", async () => {
    const dir = makeTempDir("korwf-context-art-");
    let repo: TestRepo | undefined;
    try {
      repo = buildTestRepo();
      const store = new ArtifactStore(resolveArtifactDir(dir.path));
      const { candidates, raw } = retrieveCandidates("password", { repoRoot: repo.root });

      const rawRefs = writeRawToolOutput(store, "at-context-1", raw);
      expect(rawRefs.length).toBe(raw.length);
      for (const ref of rawRefs) {
        expect(store.verify("at-context-1", ref.relativePath.split("/").slice(1).join("/"))).toBe(true);
      }

      const transport = new MockJevTransport({
        responses: candidates.flatMap(() => [
          { kind: "disabled", message: "disabled" } as const,
          { kind: "disabled", message: "disabled" } as const,
          { kind: "disabled", message: "disabled" } as const,
        ]),
      });
      const ctx: AskContext = { transport, model: "jev-test" };
      const ranked = await rankCandidates(ctx, "password", candidates);
      const entries = ranked.map((r) => toShortlistEntry(r));
      const shortlistRef = writeShortlist(store, "at-context-1", entries);
      expect(shortlistRef.sizeBytes).toBeGreaterThan(0);
      const written = JSON.parse(store.read("at-context-1", "context/shortlist.json").toString("utf8"));
      expect(Array.isArray(written)).toBe(true);
      expect(written.length).toBe(entries.length);
      expect(written[0].contentHash).toHaveLength(64);
    } finally {
      dir.cleanup();
      repo?.cleanup();
    }
  });
});
