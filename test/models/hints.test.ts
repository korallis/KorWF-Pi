/**
 * Tests for src/models/hints.ts (issue #58).
 */
import { describe, it, expect } from "vitest";
import {
  loadHints,
  resolveHints,
  normalizeForMatch,
  validateHintsFile,
  hintsFilePath,
} from "../../src/models/hints.ts";
import { readFileSync } from "node:fs";
import type { ModelRef } from "../../src/config/types.ts";

describe("loadHints — shipped file loads cleanly (#58)", () => {
  it("loads resources/hints.json without error", () => {
    const loaded = loadHints();
    expect(loaded.enabled).toBe(true);
    expect(loaded.disabledReason).toBeUndefined();
    expect(loaded.hints?.version).toBeGreaterThanOrEqual(1);
    expect(loaded.compiled.length).toBeGreaterThan(0);
  });

  it("contains no provider hostnames or the author's local proxy id ('mac-mini')", () => {
    const raw = readFileSync(hintsFilePath(), "utf8");
    expect(raw).not.toMatch(/mac-mini/i);
    expect(raw).not.toMatch(/https?:\/\//);
  });
});

describe("validateHintsFile — invalid file disabled with a message, not a crash (#58 AC)", () => {
  it("rejects a non-object document", () => {
    expect(validateHintsFile([1, 2]).issues.length).toBeGreaterThan(0);
    expect(validateHintsFile("nope").issues.length).toBeGreaterThan(0);
  });

  it("rejects a missing/invalid version", () => {
    const { issues } = validateHintsFile({ entries: [] });
    expect(issues.some((i) => i.path === "version")).toBe(true);
  });

  it("rejects an entry with an invalid regex pattern", () => {
    const { issues } = validateHintsFile({
      version: 1,
      entries: [{ pattern: "(unterminated", family: "x", aptitudes: [] }],
    });
    expect(issues.some((i) => i.path === "entries[0].pattern")).toBe(true);
  });

  it("rejects an entry missing family/aptitudes", () => {
    const { issues } = validateHintsFile({ version: 1, entries: [{ pattern: "claude" }] });
    expect(issues.some((i) => i.path === "entries[0].family")).toBe(true);
    expect(issues.some((i) => i.path === "entries[0].aptitudes")).toBe(true);
  });

  it("accepts a minimal valid document", () => {
    const { issues } = validateHintsFile({
      version: 1,
      entries: [{ pattern: "claude", family: "Claude", aptitudes: ["deep-reasoning"] }],
    });
    expect(issues).toEqual([]);
  });
});

describe("loadHints — malformed file disables hints instead of crashing (#58 AC)", () => {
  it("a nonexistent path yields enabled:false with a message", () => {
    const loaded = loadHints("/nonexistent/hints.json");
    expect(loaded.enabled).toBe(false);
    expect(loaded.disabledReason).toMatch(/could not read/i);
    expect(loaded.compiled).toEqual([]);
  });
});

describe("normalizeForMatch — strips provider prefix and cosmetic suffixes (#58)", () => {
  it("strips a provider prefix", () => {
    expect(normalizeForMatch("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("strips a date suffix", () => {
    expect(normalizeForMatch("openai/gpt-5-2025-06-20")).toBe("gpt-5");
  });

  it("strips a quantisation tag", () => {
    expect(normalizeForMatch("local/llama-3-70b-q4_k_m")).toBe("llama-3-70b");
  });

  it("strips multiple stacked suffixes", () => {
    expect(normalizeForMatch("proxy/mixtral-8x7b-instruct-latest")).toBe("mixtral-8x7b");
  });

  it("has no effect on an id with no provider prefix", () => {
    expect(normalizeForMatch("claude-sonnet-5" as ModelRef)).toBe("claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// Pattern test table: >= 20 ids, including proxied forms (#58 AC).
// ---------------------------------------------------------------------------

const PATTERN_TABLE: readonly [ref: ModelRef, expectedFamily: string | "unrated"][] = [
  ["anthropic/claude-sonnet-5", "Claude"],
  ["anthropic/claude-opus-4-1-20250805", "Claude"],
  ["mycorp/sonnet-claude-5", "Claude"], // proxied/renamed form (PLAN §3.D)
  ["openai/gpt-5", "GPT / o-series"],
  ["openai/gpt-5-2025-06-20", "GPT / o-series"],
  ["openai/o3-mini", "GPT / o-series"],
  ["proxy/gpt5-preview", "GPT / o-series"],
  ["google/gemini-2-5-pro", "Gemini"],
  ["google/gemini-2-5-flash-latest", "Gemini"],
  ["local/llama-3-70b", "Llama"],
  ["local/llama-3-70b-q4_k_m", "Llama"],
  ["local/llama-3-8b-instruct", "Llama"],
  ["dashscope/qwen-2-5-72b", "Qwen"],
  ["proxy/qwen2.5-coder-32b-instruct", "Qwen"],
  ["deepseek/deepseek-chat", "DeepSeek"],
  ["deepseek/deepseek-r1", "DeepSeek"],
  ["mistral/mistral-large-latest", "Mistral"],
  ["mistral/mixtral-8x7b-instruct-latest", "Mistral"],
  ["moonshot/kimi-k2", "Kimi"],
  ["proxy/kimi-k3-preview", "Kimi"],
  ["someorg/widget-9000", "unrated"],
  ["local/my-finetune-v3", "unrated"],
  ["acme/totally-unknown-model", "unrated"],
];

describe("resolveHints — pattern table (>=20 ids incl. proxied forms) (#58 AC)", () => {
  const loaded = loadHints();
  const refs: readonly ModelRef[] = PATTERN_TABLE.map(([ref]) => ref);
  const lookup = resolveHints(refs, loaded);

  it(`covers at least 20 ids (has ${PATTERN_TABLE.length})`, () => {
    expect(PATTERN_TABLE.length).toBeGreaterThanOrEqual(20);
  });

  for (const [ref, expectedFamily] of PATTERN_TABLE) {
    it(`"${ref}" -> ${expectedFamily}`, () => {
      const match = lookup.get(ref);
      if (expectedFamily === "unrated") {
        expect(match).toBeUndefined();
      } else {
        expect(match?.family).toBe(expectedFamily);
      }
    });
  }
});

describe("resolveHints — disabled hints never match anything (#58 AC)", () => {
  it("an invalid/disabled load yields an empty lookup, not a fabricated match", () => {
    const loaded = loadHints("/nonexistent/hints.json");
    const lookup = resolveHints(["anthropic/claude-sonnet-5" as ModelRef], loaded);
    expect(lookup.size).toBe(0);
  });
});
