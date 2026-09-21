// Minimal TypeSafe (Jev) client for the bootstrap orchestrator.
// Every decision is appended to .orchestrate/decisions.jsonl with raw
// distributions so it can be audited or replayed.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ENDPOINT = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";

export function noul(instructions, criteria) {
  return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
}
export function choice(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}
export function score(instructions, levels) {
  return { type: "score", instructions, criteria: levels };
}

export class Jev {
  constructor({ apiKey, model = "jev-latest", logPath, budgetTokens = Infinity }) {
    if (!apiKey) throw new Error("Jev API key missing (JEV_API_KEY / TYPESAFE_API_KEY)");
    this.apiKey = apiKey;
    this.model = model;
    this.logPath = logPath;
    this.budgetTokens = budgetTokens;
    this.usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
    this.failures = 0;
    this.enabled = true;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  /** Ask a batch of independent questions over one state. Returns null when Jev is unavailable. */
  async ask(kind, state, questions, meta = {}) {
    if (!this.enabled) return null;
    const used = this.usage.input_tokens + this.usage.output_tokens;
    if (used >= this.budgetTokens) {
      this.enabled = false;
      this.#log({ kind, meta, error: "jev token budget exhausted", used });
      return null;
    }
    const body = JSON.stringify({ state, model: this.model, questions });
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) {
          last = new Error(`HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const json = await res.json();
        this.usage.requests++;
        this.usage.input_tokens += json.usage?.input_tokens ?? 0;
        this.usage.output_tokens += json.usage?.output_tokens ?? 0;
        this.failures = 0;
        this.#log({ kind, meta, jevModel: json.model, questions, answers: json.answers, usage: json.usage });
        return json.answers;
      } catch (e) {
        last = e;
        if (e.name === "TimeoutError" || /fetch failed/.test(String(e))) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        break;
      }
    }
    this.failures++;
    this.#log({ kind, meta, error: String(last) });
    if (this.failures >= 5) {
      this.enabled = false; // breaker open: deterministic fallbacks from here on
      this.#log({ kind: "breaker", error: "Jev breaker opened after 5 consecutive failures" });
    }
    return null;
  }

  #log(entry) {
    if (!this.logPath) return;
    appendFileSync(this.logPath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  }
}
