/**
 * `src/workflow/intake-rules.ts` (issue #34): deterministic classification
 * rules and the trivial fast path.
 */
import { describe, it, expect } from "vitest";
import { classifyByRules, DETERMINISTIC_RULES } from "../../../src/workflow/intake-rules.ts";

describe("AC: deterministic rules run before semantic classification", () => {
  it("classifies a leading implementation verb", () => {
    const r = classifyByRules("Add a login page");
    expect(r?.intakeClass).toBe("implementation");
  });

  it("classifies investigation before the broader explanation pattern", () => {
    const r = classifyByRules("Why does the build fail intermittently?");
    expect(r?.intakeClass).toBe("investigation");
  });

  it("returns null (no rule match) for text with no deterministic signal", () => {
    expect(classifyByRules("the payment flow is broken")).toBeNull();
  });

  it("returns null for empty/whitespace text", () => {
    expect(classifyByRules("")).toBeNull();
    expect(classifyByRules("   ")).toBeNull();
  });
});

describe("AC: keep a short path for trivial work", () => {
  it("marks a short plain question with no file path as trivial", () => {
    const r = classifyByRules("What does the retry logic do?");
    expect(r?.intakeClass).toBe("explanation");
    expect(r?.trivial).toBe(true);
  });

  it("does not mark a question mentioning a file path as trivial", () => {
    const r = classifyByRules("What does src/workflow/intake.ts do?");
    expect(r?.trivial).toBe(false);
  });

  it("does not mark implementation requests as trivial", () => {
    const r = classifyByRules("Fix the null pointer exception in UserService");
    expect(r?.trivial).toBe(false);
  });
});

describe("AC: distinguish requests to discuss from requests to act", () => {
  it("a bare question with no lead verb is explanation, not implementation", () => {
    const r = classifyByRules("Is this thread-safe?");
    expect(r?.intakeClass).toBe("explanation");
  });

  it("an imperative sentence is implementation even without a question mark", () => {
    const r = classifyByRules("Add retries to the HTTP client");
    expect(r?.intakeClass).toBe("implementation");
  });
});

describe("rule set shape", () => {
  it("every rule has a unique id", () => {
    const ids = DETERMINISTIC_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
