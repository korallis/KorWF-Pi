/**
 * Redactor ⊇ repository scanner (issue #22).
 *
 * The brief for this issue is that the redaction patterns must be "at least as
 * strict as" `scripts/check-secrets.sh`. That is a property, not a one-off
 * observation, so it is asserted here against the live files: every branch of
 * the scanner's pattern, and every entry of the shipped `privacy.denyPatterns`
 * minimum in `src/config/schema.json`, must produce output that the redactor
 * changes. If someone adds a pattern to either file, this test fails until the
 * redactor covers it too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { containsSecret, redactString, REDACTED } from "../../../src/security/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Representative samples for the scanner's pattern branches. The scanner
 * matches prefixes; the redactor must match at least these, which are the
 * shortest strings the scanner would flag.
 *
 * Every sample here is fabricated. The `check-secrets:allow` markers exist
 * because these lines deliberately carry credential-shaped text.
 */
const SCANNER_SAMPLES: readonly string[] = [
  "apikey_Fake0123456789", // check-secrets:allow
  " sk-Fake0123456789abc", // check-secrets:allow
  "sk-Fake0123456789abcd", // check-secrets:allow
  "ghp_Fake0123456789abcd", // check-secrets:allow
  "JEV_API_KEY=Fake0123456789abc", // check-secrets:allow
];

describe("the redactor is at least as strict as scripts/check-secrets.sh", () => {
  it("covers every branch of the scanner's own pattern", () => {
    for (const sample of SCANNER_SAMPLES) {
      const line = `context ${sample} context`;
      expect(containsSecret(line), `not redacted: ${sample.slice(0, 8)}…`).toBe(true);
      expect(redactString(line)).toContain(REDACTED);
    }
  });

  it("the scanner's pattern definition has not grown a branch this test does not cover", () => {
    const script = readFileSync(join(repoRoot, "scripts", "check-secrets.sh"), "utf8");
    const line = script.split("\n").find((l) => l.startsWith("PATTERN="));
    expect(line, "scripts/check-secrets.sh no longer defines PATTERN=").toBeDefined();
    const pattern = (line as string).replace(/^PATTERN='/, "").replace(/'.*$/, "");
    // Branch count is asserted so a new alternative forces a new sample above.
    expect(pattern.split("|").length).toBe(5);
  });

  it("covers every shipped privacy.denyPatterns entry", () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "src", "config", "schema.json"), "utf8")) as {
      $defs: { ShippedDenyPatterns: { const: string[] } };
    };
    const shipped = schema.$defs.ShippedDenyPatterns.const;
    expect(shipped.length).toBeGreaterThan(0);
    // Each shipped pattern is a regex; a string it matches must also be
    // redacted. These are the canonical samples for each shipped entry.
    const samples: readonly string[] = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "api_key: Fake0123456789abc",
      "sk-Fake0123456789abcdef0123", // check-secrets:allow
      "AKIAFAKEFAKEFAKE1234",
      "ghp_Fake0123456789abcdef0123", // check-secrets:allow
      "xoxb-Fake0123456789-abc",
      "AIzaFake0123456789abcdefghijklmnopqrstu",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FakeSignature000000",
      "Bearer Fake0123456789abcdefghij",
      "https://user:fakepassword@example.invalid/",
    ];
    expect(samples).toHaveLength(shipped.length);
    for (let i = 0; i < shipped.length; i++) {
      const sample = samples[i] as string;
      const shippedRe = new RegExp(shipped[i] as string, "iu");
      expect(shippedRe.test(sample), `sample ${i} does not match its shipped pattern`).toBe(true);
      expect(containsSecret(sample), `shipped pattern ${i} is not covered by the redactor`).toBe(true);
    }
  });
});
