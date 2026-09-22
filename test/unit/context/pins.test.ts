/**
 * AC: "Pinned file is present in output even when Jev scores it lowest
 * (mock)." — the pin/merge half; the "scores it lowest" half is covered in
 * rank.test.ts, which merges a mock-Jev-ranked shortlist with pins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyMatcher } from "../../../src/security/deny-list.ts";
import { allPinsPresent, mergeWithPins, pinFile, pinFiles, PinDeniedError } from "../../../src/context/pins.ts";
import { verifyProvenance } from "../../../src/context/provenance.ts";
import { buildTestRepo, type TestRepo } from "./support.ts";

describe("pins.ts", () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = buildTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("pins a whole file with verifiable provenance", () => {
    const pin = pinFile(repo.root, "src/utils.ts", repo.revision);
    expect(pin.provenance.path).toBe("src/utils.ts");
    expect(pin.provenance.retrievalMethod).toBe("explicit");
    expect(verifyProvenance(pin.provenance, pin.text)).toBe(true);
  });

  it("refuses to pin a deny-listed path", () => {
    expect(() => pinFile(repo.root, ".env", repo.revision)).toThrow(PinDeniedError);
  });

  it("pinFiles pins several paths at once", () => {
    const pins = pinFiles(repo.root, ["src/auth.ts", "src/utils.ts"], repo.revision, "pinned");
    expect(pins.map((p) => p.provenance.path).sort()).toEqual(["src/auth.ts", "src/utils.ts"]);
  });

  it("AC: mergeWithPins keeps a pinned path even when absent from the ranked list", () => {
    const pin = pinFile(repo.root, "src/utils.ts", repo.revision);
    const merged = mergeWithPins([pin], []);
    expect(merged.map((c) => c.provenance.path)).toContain("src/utils.ts");
    expect(allPinsPresent([pin], merged)).toBe(true);
  });

  it("mergeWithPins prefers the pin over a ranked duplicate for the same path", () => {
    const pin = pinFile(repo.root, "src/utils.ts", repo.revision);
    const rankedDuplicate = { ...pin, matchScore: 0 };
    const merged = mergeWithPins([pin], [rankedDuplicate]);
    expect(merged.filter((c) => c.provenance.path === "src/utils.ts")).toHaveLength(1);
  });

  it("respects an injected DenyMatcher's extra config entries", () => {
    const matcher = new DenyMatcher({ denyPaths: ["**/utils.ts"] });
    expect(() => pinFile(repo.root, "src/utils.ts", repo.revision, "explicit", matcher)).toThrow(PinDeniedError);
  });
});
