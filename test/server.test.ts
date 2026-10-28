import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { acquireServer, type ServerLease } from "../lib/server.ts";

type UpstreamHandler = (url: string, init: RequestInit) => Promise<Response>;

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let lease: ServerLease;
let upstream: UpstreamHandler;
let calls: UpstreamCall[] = [];

/** Upstream stub: records the call, then defers to the per-test handler. */
function stubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const rawBody = typeof init.body === "string" ? init.body : "{}";
  calls.push({
    url,
    headers: { ...(init.headers as Record<string, string>) },
    body: JSON.parse(rawBody) as Record<string, unknown>,
  });
  return upstream(url, init);
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function post(path: string, body: unknown, authorization = "Bearer test"): Promise<Response> {
  return realFetch(`http://127.0.0.1:${lease.port}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface RawResult {
  complete: boolean;
  body: string;
  error?: string;
}

/** Raw http call — fetch cannot set a Host header and hides mid-stream resets. */
function rawRequest(path: string, options: { host?: string; body?: unknown } = {}): Promise<RawResult & { status?: number }> {
  const { promise, resolve } = Promise.withResolvers<RawResult & { status?: number }>();
  const req = request(
    {
      host: "127.0.0.1",
      port: lease.port,
      path,
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        ...(options.host && { host: options.host }),
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
    },
    (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, complete: res.complete, body }));
      res.on("error", (e: NodeJS.ErrnoException) =>
        resolve({ status: res.statusCode, complete: false, body, error: e.code ?? e.message }),
      );
    },
  );
  req.on("error", (e: NodeJS.ErrnoException) => resolve({ complete: false, body: "", error: e.code ?? e.message }));
  req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  return promise;
}

function sseStream(chunks: string[], failAfter?: string): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = chunks[i++];
        if (chunk !== undefined) {
          controller.enqueue(encoder.encode(chunk));
        } else if (failAfter !== undefined) {
          controller.error(new Error(failAfter));
        } else {
          controller.close();
        }
      },
    }),
    { status: 200 },
  );
}

before(async () => {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  globalThis.fetch = stubFetch as typeof fetch;
  lease = await acquireServer();
});

after(() => {
  lease.release();
  globalThis.fetch = realFetch;
});

describe("request validation", () => {
  it("rejects a foreign Host header (DNS rebinding) before touching anything", async () => {
    const res = await rawRequest("/junie/balance", { host: "evil.example" });
    assert.equal(res.status, 403);
    assert.equal(calls.length, 0);
  });

  it("sends no CORS headers, so web pages cannot read the bridge", async () => {
    const res = await realFetch(`http://127.0.0.1:${lease.port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("answers 400, not 500, for a body that is not JSON or lacks a string model", async () => {
    calls = [];
    for (const body of ["{not json", "[]", "{}", JSON.stringify({ model: 5 })]) {
      const res = await post("/v1/messages", body);
      assert.equal(res.status, 400, `body ${body}`);
    }
    assert.equal(calls.length, 0);
  });

  it("answers 401 without credentials", async () => {
    const res = await realFetch(`http://127.0.0.1:${lease.port}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  });

  it("refuses a model on the wrong route", async () => {
    const res = await post("/v1/messages", { model: "openai-gpt-5-5" });
    assert.equal(res.status, 400);
  });
});

describe("upstream payloads", () => {
  it("renames OpenAI models to Grazie's name and drops fields the backend rejects", async () => {
    calls = [];
    upstream = async () => jsonResponse(200, { ok: true });
    const res = await post("/v1/responses", {
      model: "openai-gpt-6-1-sol",
      input: [],
      max_output_tokens: 10,
      service_tier: "auto",
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body.model, "gpt-6.1-sol");
    assert.equal("max_output_tokens" in (calls[0]?.body ?? {}), false);
    assert.equal(calls[0]?.headers["X-LLM-Model"], "openai");
  });

  it("routes Grok through the same payload with the grok routing header", async () => {
    calls = [];
    upstream = async () => jsonResponse(200, { ok: true });
    await post("/v1/responses", { model: "grok-4-7", input: [] });
    assert.equal(calls[0]?.body.model, "grok-4.7");
    assert.equal(calls[0]?.headers["X-LLM-Model"], "grok");
  });

  it("passes upstream errors through with their status and body", async () => {
    upstream = async () => new Response("bad request details", { status: 400 });
    const res = await post("/v1/messages", { model: "claude-sonnet-5", messages: [] });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, "bad request details");
  });
});

describe("streaming", () => {
  it("relays a complete stream byte for byte", async () => {
    upstream = async () => sseStream(["data: one\n\n", "data: two\n\n"]);
    const res = await rawRequest("/v1/messages", { body: { model: "claude-sonnet-5", stream: true, messages: [] } });
    assert.equal(res.complete, true);
    assert.equal(res.body, "data: one\n\ndata: two\n\n");
  });

  it("cuts the connection when upstream dies mid-stream instead of ending cleanly", async () => {
    // A clean end would look like a finished (but truncated) message to Pi.
    upstream = async () => sseStream(["data: one\n\n"], "upstream reset");
    const res = await rawRequest("/v1/messages", { body: { model: "claude-sonnet-5", stream: true, messages: [] } });
    assert.equal(res.complete, false);
    assert.ok(res.error, "client should see a connection error");
  });
});

describe("shared server", () => {
  it("stays up until the last lease is released, then closes", async () => {
    const second = await acquireServer();
    assert.equal(second.port, lease.port);

    second.release();
    second.release(); // releasing twice must not steal the other holder's reference
    const stillUp = await realFetch(`http://127.0.0.1:${lease.port}/`);
    assert.equal(stillUp.status, 200);

    lease.release();
    await assert.rejects(realFetch(`http://127.0.0.1:${lease.port}/`, { signal: AbortSignal.timeout(2000) }));

    // A new acquire starts a fresh server rather than reusing the closed one.
    lease = await acquireServer();
    const fresh = await realFetch(`http://127.0.0.1:${lease.port}/`);
    assert.equal(fresh.status, 200);
  });
});

describe("balance", () => {
  it("asks Grazie for the non-EAP bucket on /auth/test and every quota call", async () => {
    calls = [];
    upstream = async () => jsonResponse(200, { active: true, balanceLeft: 1, balanceUnit: "CREDITS" });
    const res = await rawRequest("/junie/balance?full=1");
    assert.equal(res.status, 200);

    const authTest = calls.filter((c) => c.url.endsWith("/auth/test"));
    const quota = calls.filter((c) => c.url.includes("/quota/"));
    assert.equal(authTest.length, 1);
    assert.equal(quota.length, 2);
    for (const c of [...authTest, ...quota]) {
      assert.equal(c.headers["X-Accept-EAP-License"], "false", c.url);
    }
  });

  it("skips the refill metadata request on status-bar polls and falls back to balanceLeft when quota buckets are absent", async () => {
    calls = [];
    upstream = async (url) =>
      url.includes("/quota/get")
        ? jsonResponse(200, { current: { license: "lic-1" } })
        : jsonResponse(200, { active: true, balanceLeft: 42, balanceUnit: "CREDITS" });

    const res = await rawRequest("/junie/balance");
    assert.equal(res.status, 200);
    assert.equal(calls.filter((c) => c.url.includes("/quota/metadata/refill")).length, 0);
    const body = JSON.parse(res.body) as { balanceLeft: number };
    assert.equal(body.balanceLeft, 42);
  });
});

// Kept last: this permanently flips the bridge's X-Free-Google-Api state.
describe("477 from Grazie", () => {
  it("drops X-Free-Google-Api and repeats the request once, transparently", async () => {
    calls = [];
    let n = 0;
    upstream = async () => (n++ === 0 ? new Response("blocked", { status: 477 }) : jsonResponse(200, { ok: true }));

    const res = await post("/v1/messages", { model: "claude-sonnet-5", messages: [] });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers["X-Free-Google-Api"], "true");
    assert.equal(calls[1]?.headers["X-Free-Google-Api"], undefined);
  });
});
