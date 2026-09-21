/**
 * `HttpJevTransport` (issue #24). Tested only against a local fake HTTP
 * server started in this file — never the real TypeSafe API.
 *
 * AC1: "No test makes a network request to typesafe.ai (assert via a fetch
 * stub that fails on unknown hosts)."
 * AC3: "Base URL override is honoured (fake server test)."
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpJevTransport } from "../../../src/jev/http.ts";
import { JevTransportError, type SystemOneRequest } from "../../../src/jev/transport.ts";
import { Secret } from "../../../src/security/secrets.ts";
import { clearRegisteredSecrets } from "../../../src/security/redact.ts";

const FAKE_KEY = "apikey_ZZZZfakefakefake0123456789abcdef"; // check-secrets:allow

function secret(): Secret {
  return new Secret(FAKE_KEY, "TypeSafe API key", { kind: "env", name: "TYPESAFE_API_KEY", viaFallbackName: false });
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

let server: Server;
let baseUrl: string;
let handler: Handler = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
};
let receivedRequests: { headers: IncomingMessage["headers"]; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      receivedRequests.push({ headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server not listening");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  receivedRequests = [];
  clearRegisteredSecrets();
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
  };
});

const REQUEST: SystemOneRequest = {
  state: "hello",
  model: "jev-1.13.0",
  questions: { q: { type: "noul", instructions: "Is this a test?" } },
};

function transport(overrides: Partial<ConstructorParameters<typeof HttpJevTransport>[0]> = {}): HttpJevTransport {
  return new HttpJevTransport({
    baseUrl,
    model: "jev-1.13.0",
    apiKey: secret(),
    timeoutMs: 2000,
    maxRetries: 2,
    ...overrides,
  });
}

describe("AC1: no live network request", () => {
  it("a fetch stub that fails on unknown hosts is never triggered for typesafe.ai", async () => {
    const failingFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.startsWith(baseUrl)) throw new Error(`unexpected network request to ${url}`);
      return fetch(input);
    };
    const t = transport({ fetchImpl: failingFetch });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
  });
});

describe("AC3: base URL override is honoured", () => {
  it("requests hit the configured baseUrl, not the default", async () => {
    const t = transport();
    await t.evaluate(REQUEST);
    expect(receivedRequests).toHaveLength(1);
  });

  it("posts to /v1/systemone with the pinned model and questions", async () => {
    let seenUrl = "";
    handler = (req, res) => {
      seenUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
    };
    const t = transport();
    await t.evaluate(REQUEST);
    expect(seenUrl).toBe("/v1/systemone");
    expect(receivedRequests[0]!.body).toEqual({ state: "hello", model: "jev-1.13.0", questions: REQUEST.questions });
  });
});

describe("headers", () => {
  it("sends Authorization: Bearer <key>, Content-Type and User-Agent only", async () => {
    const t = transport();
    await t.evaluate(REQUEST);
    const headers = receivedRequests[0]!.headers;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBeDefined();
  });
});

describe("success", () => {
  it("returns kind: ok with the raw response and requestId from the header", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "x-typesafe-request-id": "req-123" });
      res.end(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.4 } }, usage: { input_tokens: 3, output_tokens: 0 } }));
    };
    const t = transport();
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.requestId).toBe("req-123");
      expect(result.response.answers["q"]).toEqual({ type: "noul", noul: 0.4 });
    }
  });
});

describe("error mapping", () => {
  it("401 maps to jev.auth and is not retried", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid key" }));
    };
    const t = transport();
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error.code).toBe("jev.auth");
      expect(result.error.status).toBe(401);
    }
    expect(calls).toBe(1);
  });

  it("422 maps to jev.bad_request and is not retried", async () => {
    handler = (_req, res) => {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad field" }));
    };
    const t = transport();
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.bad_request");
  });

  it("429 retries up to maxRetries then maps to jev.rate_limited", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(429, { "Content-Type": "application/json", "retry-after-ms": "5" });
      res.end(JSON.stringify({ error: "rate limited" }));
    };
    const t = transport({ maxRetries: 2 });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.rate_limited");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("529 maps to jev.overloaded", async () => {
    handler = (_req, res) => {
      res.writeHead(529, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "overloaded" }));
    };
    const t = transport({ maxRetries: 0 });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.overloaded");
  });

  it("a 429 that eventually succeeds within maxRetries returns ok", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls < 2) {
        res.writeHead(429, { "Content-Type": "application/json", "retry-after-ms": "1" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
    };
    const t = transport({ maxRetries: 2 });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("ok");
    expect(calls).toBe(2);
  });

  it("malformed (non-JSON) success body maps to jev.malformed_response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    };
    const t = transport();
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.malformed_response");
  });
});

describe("deadline and cancellation", () => {
  it("aborting the caller signal yields jev.cancelled", async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
      }, 200);
    };
    const t = transport({ timeoutMs: 5000 });
    const controller = new AbortController();
    const promise = t.evaluate(REQUEST, { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error.code).toBe("jev.cancelled");
  });

  it("a slow server past the deadline yields a non-ok result, never hangs", async () => {
    handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
      }, 300);
    };
    const t = transport({ timeoutMs: 50, maxRetries: 0 });
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
  });
});

describe("redaction", () => {
  it("the key never appears in a JevTransportError's message or JSON form", async () => {
    handler = (_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `invalid key Bearer ${FAKE_KEY}` }));
    };
    const t = transport();
    const result = await t.evaluate(REQUEST);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      const err = result.error;
      expect(err).toBeInstanceOf(JevTransportError);
      expect(err.message).not.toContain(FAKE_KEY);
      expect(JSON.stringify(err)).not.toContain(FAKE_KEY);
    }
  });
});
