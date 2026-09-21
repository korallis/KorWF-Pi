/**
 * Stage 2 exit criterion, part 4 (first half): "failures cannot hang Pi"
 * (issue #32; PLAN §8 Stage 2 Exit; issue #26 resilience).
 *
 * A deliberately broken transport is used in three ways — one that never
 * answers, one that throws on contact, and one pointed at an unroutable
 * address — and in every case the caller must get a bounded, typed failure
 * that degrades to the question's deterministic fallback. A hang here would
 * freeze the Pi session the extension runs in, so each assertion is wrapped
 * in a wall-clock bound rather than left to the suite timeout.
 *
 * Alongside that, a Pi session whose store is corrupted on disk must report
 * the failure and exit cleanly instead of hanging or crashing.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../../src/decisions/ask.ts";
import { echoQuestion } from "../../../src/decisions/examples.ts";
import { HttpJevTransport } from "../../../src/jev/http.ts";
import { filterForTest } from "../../../src/jev/mock.ts";
import { noulQuestion, type JevTransport } from "../../../src/jev/transport.ts";
import { wrapWithCircuitBreaker } from "../../../src/jev/resilience.ts";
import { Secret } from "../../../src/security/secrets.ts";
import { redactString } from "../../../src/security/redact.ts";
import { resolveStorageRoot, resolveDatabasePath } from "../../../src/storage/paths.ts";
import {
  installPackage,
  makeIsolatedPi,
  piCliAvailable,
  runKorwf,
} from "./pi-session.ts";

const available = piCliAvailable();
const MODEL = "jev-test";

/** A key-shaped value that exists only in this process. */
function fakeSecret(): Secret {
  return new Secret("korwffake-transport-probe", "TypeSafe API key", {
    kind: "env",
    name: "TYPESAFE_API_KEY",
    viaFallbackName: false,
  });
}

/** Build a transport over a caller-supplied broken `fetch`. */
function brokenTransport(fetchImpl: typeof fetch, timeoutMs: number): JevTransport {
  return wrapWithCircuitBreaker(
    new HttpJevTransport({
      baseUrl: "https://jev.invalid",
      model: MODEL,
      apiKey: fakeSecret(),
      timeoutMs,
      maxRetries: 1,
      fetchImpl,
    }),
    { deadlineMs: timeoutMs, maxRetries: 1 },
  );
}

const HANG_BUDGET_MS = 5_000;

describe("M2 exit: a broken transport degrades, it does not hang", () => {
  it("a transport that never answers is bounded by the deadline", async () => {
    // The worst case: a `fetch` whose promise never settles unless aborted.
    const neverAnswers: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolveFetch, rejectFetch) => {
        init?.signal?.addEventListener("abort", () => {
          rejectFetch(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });

    const startedAt = Date.now();
    const result = await ask(
      { transport: brokenTransport(neverAnswers, 200), model: MODEL },
      echoQuestion,
      { text: "hello" },
    );
    const elapsed = Date.now() - startedAt;

    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("transport_error");
    expect(elapsed).toBeLessThan(HANG_BUDGET_MS);
  });

  it("a transport that throws on contact falls back without throwing", async () => {
    const throwsImmediately: typeof fetch = () => {
      throw new Error("socket closed by peer");
    };

    const result = await ask(
      { transport: brokenTransport(throwsImmediately, 500), model: MODEL },
      echoQuestion,
      { text: "hello" },
    );
    expect(result.source).toBe("fallback");
    expect(result.value).toBe(true);
    expect(result.jevModelVersion).toBeNull();
  });

  it("a transport returning garbage falls back rather than propagating it", async () => {
    const garbage: typeof fetch = () =>
      Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 200 }));

    const transport = brokenTransport(garbage, 500);
    const raw = await transport.evaluate(
      filterForTest({ model: MODEL, state: {}, questions: { q: noulQuestion("ok?") } }),
    );
    expect(raw.kind).toBe("error");

    const result = await ask({ transport, model: MODEL }, echoQuestion, { text: "hello" });
    expect(result.source).toBe("fallback");
  });

  it("an unroutable address fails fast instead of waiting on the network", async () => {
    // Port 1 on the loopback interface: connection refused, immediately, on
    // every CI runner, with no DNS and no traffic leaving the machine.
    const transport = wrapWithCircuitBreaker(
      new HttpJevTransport({
        baseUrl: "http://127.0.0.1:1",
        model: MODEL,
        apiKey: fakeSecret(),
        timeoutMs: 2_000,
        maxRetries: 0,
      }),
      { deadlineMs: 2_000, maxRetries: 0 },
    );

    const startedAt = Date.now();
    const result = await ask({ transport, model: MODEL }, echoQuestion, { text: "hello" });
    expect(Date.now() - startedAt).toBeLessThan(HANG_BUDGET_MS);
    expect(result.source).toBe("fallback");
    expect(result.reason).toBe("transport_error");
  });

  it("the failure message carries no credential material", async () => {
    const secret = fakeSecret();
    const echoesTheHeader: typeof fetch = (_input, init) => {
      const headers = new Headers(init?.headers);
      // A hostile server reflecting the Authorization header back at us.
      throw new Error(`upstream rejected: ${headers.get("Authorization") ?? "none"}`);
    };

    const transport = wrapWithCircuitBreaker(
      new HttpJevTransport({
        baseUrl: "https://jev.invalid",
        model: MODEL,
        apiKey: secret,
        timeoutMs: 500,
        maxRetries: 0,
        fetchImpl: echoesTheHeader,
      }),
      { deadlineMs: 500, maxRetries: 0 },
    );
    const raw = await transport.evaluate(
      filterForTest({ model: MODEL, state: {}, questions: { q: noulQuestion("ok?") } }),
    );
    expect(raw.kind).toBe("error");
    // Two independent guarantees: the structured result carries no message
    // at all, and anything that *is* rendered goes through the redactor,
    // which replaces the registered value wherever it appears (#22).
    expect(JSON.stringify(raw)).not.toContain(secret.expose());
    const message = raw.kind === "error" ? raw.error.message : "";
    expect(message).not.toContain(secret.expose());
    expect(redactString(`upstream rejected: Bearer ${secret.expose()}`)).toContain("[redacted]");
  });
});

describe.skipIf(!available)("M2 exit: a failing command cannot hang the Pi session", () => {
  it("a corrupted store is reported and the session still exits", () => {
    const pi = makeIsolatedPi("korwf-broken-store-");
    try {
      expect(installPackage(pi).status).toBe(0);

      // Not a SQLite database at all. `/korwf why` opens the store, so this
      // is the failure path a user hits after a bad disk or a partial copy.
      const storageRoot = resolveStorageRoot(pi.project);
      mkdirSync(storageRoot, { recursive: true });
      writeFileSync(resolveDatabasePath(storageRoot), "this is not a database\n");

      const run = runKorwf(pi, ["/korwf why", "/korwf version"], { timeoutMs: 30_000 });

      // Exited on its own: not killed by the harness timeout.
      expect(run.signal).toBeNull();
      expect(run.status).toBe(0);
      expect(run.elapsedMs).toBeLessThan(30_000);

      // The failure is reported, and the session keeps serving commands.
      expect(run.transcript).toContain("could not complete /korwf why");
      expect(run.transcript).toContain("korwf-pi v");
    } finally {
      pi.cleanup();
    }
  });

  it("an unwritable storage root degrades to a message, not a hang", () => {
    const pi = makeIsolatedPi("korwf-unwritable-");
    try {
      expect(installPackage(pi).status).toBe(0);
      // A storage root pointed at a path that cannot be created: the parent
      // is a regular file, so `mkdir` fails at the first write.
      const blocker = join(pi.root, "blocked");
      writeFileSync(blocker, "not a directory\n");

      const run = runKorwf(pi, ["/korwf why", "/korwf version"], {
        env: { KORWF_STORAGE_PATH: join(blocker, "store") },
        timeoutMs: 30_000,
      });
      expect(run.signal).toBeNull();
      expect(run.elapsedMs).toBeLessThan(30_000);
      expect(run.transcript).toContain("korwf-pi v");
    } finally {
      pi.cleanup();
    }
  });
});
