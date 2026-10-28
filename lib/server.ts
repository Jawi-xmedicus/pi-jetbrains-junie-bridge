import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as dns } from "node:dns";
import { KNOWN_GRAZIE_MODELS, isLegacyModel, upstreamModelId } from "./models.ts";
import { proxyFetch, getProxyDiagnostics } from "./proxy.ts";

// ─── Upstream Config ─────────────────────────────────────────────────────────
const UPSTREAM_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";
const GRAZIE_AUTH_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";

// Balance/quota lookups back a status line and the /junie command — better to
// report a missing number than to keep the user waiting.
const BALANCE_TIMEOUT_MS = 8000;

// Identifies the bridge to Grazie as the Junie CLI build the model list was
// extracted from — keep in sync with the version noted in models.ts.
const GRAZIE_AGENT = JSON.stringify({ name: "junie:cli", version: "3659.7" });

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

// ─── Proxy State (non-auth) ─────────────────────────────────────────────────
const state: { freeGoogleApi: boolean; lastAuthHeader: string | undefined } = {
  freeGoogleApi: true,
  lastAuthHeader: undefined, // cached from last chat request for /junie/balance
};

type JsonObject = Record<string, unknown>;
/** A request body Pi sends to the proxy — only `model` is inspected before sanitizing. */
type Payload = JsonObject & { model: string };

// Google models are not served on an OpenAI-shaped route: Junie talks to them
// through a Vertex-style generateContent path (LLMAccess$Companion.
// googleGenerateContent), with "jetbrains-grazie" as the project.
const GOOGLE_PROJECT = "jetbrains-grazie";

// ─── Headers ─────────────────────────────────────────────────────────────────
// Without X-Accept-EAP-License: false, Grazie picks JUNP (USD, EAP) over
// AIP/AIPU (CREDITS) on /auth/test and QuotaAPI, so the balance would show a
// different bucket than chat consumes.
export function grazieUserHeaders(auth: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Authorization": auth, "X-Accept-EAP-License": "false", ...extra };
}

function openaiHeaders(authHeader: string): Record<string, string> {
  const h = grazieUserHeaders(authHeader, {
    "Content-Type": "application/json",
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": GRAZIE_AGENT,
    "X-LLM-Model": "openai",
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
  });
  if (state.freeGoogleApi) h["X-Free-Google-Api"] = "true";
  return h;
}

// Grok goes through the same OpenAI Responses payload/path, only the
// X-LLM-Model routing header differs (LlmProvider.XAI → "grok" in
// IngrazzioLLMAccessKt).
function grokHeaders(authHeader: string): Record<string, string> {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "grok" };
}

function googleHeaders(authHeader: string): Record<string, string> {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "google" };
}

function anthropicHeaders(authHeader: string): Record<string, string> {
  const h = grazieUserHeaders(authHeader, {
    "Content-Type": "application/json",
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": GRAZIE_AGENT,
    "X-LLM-Model": "anthropic",
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
  });
  if (state.freeGoogleApi) h["X-Free-Google-Api"] = "true";
  return h;
}

// ─── Payload Sanitization ───────────────────────────────────────────────────
const OPENAI_ALLOWED = new Set([
  "model", "messages", "max_tokens", "temperature", "top_p",
  "stream", "stream_options", "stop", "tools", "tool_choice", "seed",
  "response_format", "max_completion_tokens", "reasoning_effort",
]);

const ANTHROPIC_ALLOWED = new Set([
  "model", "messages", "max_tokens", "system", "metadata",
  "stop_sequences", "stream", "temperature", "top_p", "top_k",
  "tools", "tool_choice", "thinking", "output_config",
]);

// OpenAI Responses API (/v1/responses) — the only OpenAI surface on the Grazie
// backend that accepts `reasoning.effort` together with function tools. The
// allow-list mirrors the fields of the upstream CreateResponsePayload schema;
// anything Pi sends that the backend doesn't understand (e.g. max_output_tokens,
// service_tier) is dropped to avoid strict-deserialization errors.
const RESPONSES_ALLOWED = new Set([
  "model", "input", "instructions", "metadata", "tools", "tool_choice",
  "include", "reasoning", "text", "response_format", "parallel_tool_calls",
  "prompt_cache_key", "prompt_cache_retention", "previous_response_id",
  "store", "stream", "temperature", "top_p", "cache_control",
]);

function sanitizeOpenAI(payload: Payload): JsonObject {
  const safe: JsonObject = {};
  for (const [k, v] of Object.entries(payload)) {
    if (OPENAI_ALLOWED.has(k)) safe[k] = v;
  }
  safe.model = upstreamModelId(payload.model);
  if (safe.stream) {
    safe.stream_options = { include_usage: true, ...((safe.stream_options as object | undefined) ?? {}) };
  }
  return safe;
}

function sanitizeResponses(payload: Payload): JsonObject {
  const safe: JsonObject = {};
  for (const [k, v] of Object.entries(payload)) {
    if (RESPONSES_ALLOWED.has(k)) safe[k] = v;
  }
  safe.model = upstreamModelId(payload.model);
  return safe;
}

function sanitizeAnthropic(payload: Payload): JsonObject {
  const safe: JsonObject = {};
  for (const [k, v] of Object.entries(payload)) {
    if (ANTHROPIC_ALLOWED.has(k)) {
      safe[k] = k === "system" ? sanitizeSystem(v) : v;
    }
  }
  return safe;
}

function sanitizeSystem(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  return system.map((block) => {
    if (typeof block !== "object" || block === null || !("cache_control" in block)) return block;
    const { cache_control, ...rest } = block;
    if (typeof cache_control !== "object" || cache_control === null) return block;
    return { ...rest, cache_control: { type: cache_control.type } };
  });
}

// ─── Upstream Requests ──────────────────────────────────────────────────────
/**
 * POST upstream. Grazie answers 477 when X-Free-Google-Api is not accepted for
 * the account; the header is then dropped for good and the request repeated
 * once. `headersFor` is re-evaluated so the retry sees the new state.
 */
async function postUpstream(
  url: string,
  headersFor: () => Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  const send = () => proxyFetch(url, { method: "POST", headers: headersFor(), body, signal });
  let res = await send();
  if (res.status === 477 && state.freeGoogleApi) {
    state.freeGoogleApi = false;
    await res.body?.cancel().catch(() => {});
    res = await send();
  }
  return res;
}

function forwardOpenAI(payload: Payload, authHeader: string, signal: AbortSignal): Promise<Response> {
  return postUpstream(
    `${UPSTREAM_BASE}/v1/chat/completions`,
    () => openaiHeaders(authHeader),
    JSON.stringify(sanitizeOpenAI(payload)),
    signal,
  );
}

function forwardResponses(payload: Payload, authHeader: string, signal: AbortSignal): Promise<Response> {
  return postUpstream(
    `${UPSTREAM_BASE}/v1/responses`,
    () => (payload.model.startsWith("grok-") ? grokHeaders(authHeader) : openaiHeaders(authHeader)),
    JSON.stringify(sanitizeResponses(payload)),
    signal,
  );
}

function forwardGoogle(
  model: string,
  method: string,
  search: string,
  body: string,
  authHeader: string,
  signal: AbortSignal,
): Promise<Response> {
  return postUpstream(
    `${UPSTREAM_BASE}/v1beta1/projects/${GOOGLE_PROJECT}/locations/global/publishers/google/models/${model}:${method}${search}`,
    () => googleHeaders(authHeader),
    body,
    signal,
  );
}

function forwardAnthropic(payload: Payload, authHeader: string, signal: AbortSignal): Promise<Response> {
  return postUpstream(
    `${UPSTREAM_BASE}/v1/messages`,
    () => anthropicHeaders(authHeader),
    JSON.stringify(sanitizeAnthropic(payload)),
    signal,
  );
}

// ─── Error Helpers ──────────────────────────────────────────────────────────
const PROXY_407_HINT =
  "Your corporate proxy requires NTLM/Kerberos authentication, which is not supported directly. " +
  "Install a local proxy like px (https://github.com/genotrance/px) that handles NTLM/Kerberos, " +
  "then set HTTPS_PROXY=http://localhost:<px-port> before starting Pi.";

interface ErrorWithCause { message?: string; code?: string; cause?: ErrorWithCause }

function extractErrorMessage(e: unknown): string {
  const err = e as ErrorWithCause;
  const parts: (string | undefined)[] = [err.message];
  if (err.cause) {
    parts.push(err.cause.message ?? String(err.cause));
    if (err.cause.code) parts.push(`code=${err.cause.code}`);
    if (err.cause.cause) parts.push(err.cause.cause.message ?? String(err.cause.cause));
  }
  const msg = parts.filter(Boolean).join(" — ");
  if (/407/.test(msg)) return `${msg}\n\nHint: ${PROXY_407_HINT}`;
  return msg;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  req.on("error", reject);
  return promise;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function getAuthHeader(req: IncomingMessage): string | undefined {
  // The @google/genai SDK sends the key as x-goog-api-key, everything else as
  // a bearer token in Authorization.
  const googleKey = req.headers["x-goog-api-key"];
  if (!req.headers.authorization && typeof googleKey === "string") {
    return `Bearer ${googleKey}`;
  }
  return req.headers.authorization;
}

/**
 * Abort signal that fires when Pi drops the connection before the response is
 * complete (e.g. Esc during a turn), so the upstream request — and the credits
 * it burns — stops with it.
 */
function clientSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

async function pipeSSE(upstreamRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) { res.end(); return; }

  // Cancelling the reader closes the upstream connection.
  res.once("close", () => { reader.cancel().catch(() => {}); });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        const { promise: drained, resolve: onDrained } = Promise.withResolvers<void>();
        res.once("drain", onDrained);
        res.once("close", onDrained);
        await drained;
      }
    }
  } catch (e) {
    // Upstream died mid-stream. Ending the response cleanly would hand Pi a
    // truncated stream that looks complete ("stream ended before message_stop"
    // with no cause), so cut the connection and let the client report and
    // retry a real network error. Nothing to do if Pi itself hung up.
    if (!res.destroyed) res.destroy(e instanceof Error ? e : undefined);
    return;
  }
  res.end();
}

const INVALID_BODY_MESSAGE = "Request body must be a JSON object with a string `model`.";

/** Parses a request body; null unless it is a JSON object carrying a string `model`. */
function parsePayload(body: string): Payload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (!("model" in parsed) || typeof parsed.model !== "string") return null;
  return { ...parsed, model: parsed.model };
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = parsePayload(body);
    if (!payload) {
      sendJson(res, 400, { error: { message: INVALID_BODY_MESSAGE, type: "invalid_request" } });
      return;
    }

    if (!payload.model.startsWith("openai-")) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/chat/completions. Use openai-*/grok-* via /v1/responses, claude-* via /v1/messages, or gemini-* via /google/v1beta.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardOpenAI(payload, auth, clientSignal(res));

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = parsePayload(body);
    if (!payload) {
      sendJson(res, 400, { error: { message: INVALID_BODY_MESSAGE, type: "invalid_request" } });
      return;
    }

    if (!payload.model.startsWith("openai-") && !payload.model.startsWith("grok-")) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/responses. Use claude-* via /v1/messages or gemini-* via /google/v1beta.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardResponses(payload, auth, clientSignal(res));

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = parsePayload(body);
    if (!payload) {
      sendJson(res, 400, { error: { message: INVALID_BODY_MESSAGE, type: "invalid_request" } });
      return;
    }

    if (!payload.model.startsWith("claude-")) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/messages. Use openai-*/grok-* via /v1/responses or gemini-* via /google/v1beta.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardAnthropic(payload, auth, clientSignal(res));

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

/**
 * Google route. pi-ai's @google/genai client posts to
 * /google/v1beta/models/<model>:<method> (method being generateContent or
 * streamGenerateContent, the latter with ?alt=sse); this rewrites it onto the
 * Grazie Vertex path. Request and response bodies pass through untouched —
 * the Grazie backend speaks the same generateContent schema.
 */
async function handleGoogle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  const match = url.pathname.match(/\/models\/([^:/]+):(\w+)$/);
  if (!match) {
    sendJson(res, 404, { error: { message: `Unsupported Google path: ${url.pathname}`, type: "not_found" } });
    return;
  }
  const [, model = "", method = ""] = match;

  if (!model.startsWith("gemini-")) {
    sendJson(res, 400, { error: { message: `Model ${model} is not a Google model.`, type: "invalid_request" } });
    return;
  }

  try {
    const body = await readBody(req);
    const upstream = await forwardGoogle(model, method, url.search, body, auth, clientSignal(res));

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (url.searchParams.get("alt") === "sse") {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

/** Body of GET /v1/models. */
export interface ModelsResponse {
  object: "list";
  data: { id: string; object: "model"; created: number; owned_by: string }[];
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  const models = KNOWN_GRAZIE_MODELS
    .filter((id) => !isLegacyModel(id))
    .map((id) => ({
      id,
      object: "model" as const,
      created: 0,
      owned_by: id.split("-")[0] ?? id,
    }));
  const body: ModelsResponse = { object: "list", data: models };
  sendJson(res, 200, body);
}

// Grazie's QuotaAPI — the same endpoints IntelliJ/Junie-in-IDE use (see
// QuotaAPIClient in the ml-llm plugin). They live on the same host as
// /auth/test and accept the same bearer token, but unlike /auth/test they
// break the balance down into tariff (subscription) and top-up credits.
// Amounts are Credit objects: { "amount": "1969436.7795" }.
// Accounts without an active licence (plain TRIAL credits) get a 400 here —
// hence every quota call is best-effort and never fails the balance itself.
// ── Shapes of the Grazie responses the bridge reads (all fields optional: the
// backend is not ours, so nothing is assumed beyond what is accessed below).
interface GrazieCredit { amount?: string | number }
interface GrazieQuotaDetails { current?: GrazieCredit; maximum?: GrazieCredit; available?: GrazieCredit }
interface GrazieQuotaResponse {
  current?: {
    license?: string;
    current?: GrazieCredit;
    maximum?: GrazieCredit;
    until?: number;
    tariffQuota?: GrazieQuotaDetails;
    topUpQuota?: GrazieQuotaDetails;
  };
}
interface GrazieRefillResponse {
  current?: {
    next?: number;
    last?: number;
    tariff?: { amount?: GrazieCredit; period?: { millis?: number } };
  };
}
interface AuthTestResponse {
  balanceLeft?: number;
  balanceUnit?: string;
  licenseType?: string;
  active?: boolean;
}

export interface CreditBucket { spent?: number; maximum?: number; available?: number }
export interface QuotaSummary {
  license?: string;
  spent?: number;
  maximum?: number;
  available?: number;
  until?: number;
  tariff?: CreditBucket;
  topUp?: CreditBucket;
  refill?: { next?: number; last?: number; amount?: number; periodMs?: number };
}
/** Body of GET /junie/balance — also what the error branches send (`error` only). */
export interface BalanceResponse {
  balanceLeft?: number;
  balanceUnit?: string;
  licenseType?: string;
  active?: boolean;
  quota?: QuotaSummary;
  error?: { message: string; type: string };
}

async function grazieQuotaPost<T>(auth: string, path: string): Promise<T> {
  const upstream = await proxyFetch(`${GRAZIE_AUTH_BASE}${path}`, {
    method: "POST",
    headers: grazieUserHeaders(auth, { "Content-Type": "application/json" }),
    body: "{}",
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error(`${path} → ${upstream.status}`);
  return (await upstream.json()) as T;
}

function creditAmount(credit: GrazieCredit | undefined): number | undefined {
  const n = Number(credit?.amount);
  return Number.isFinite(n) ? n : undefined;
}

// { current, maximum, available } — note that Grazie's "current" is the amount
// *spent*, not the amount left; "available" is what remains.
function quotaDetails(details: GrazieQuotaDetails | undefined): CreditBucket | undefined {
  if (!details) return undefined;
  return {
    spent: creditAmount(details.current),
    maximum: creditAmount(details.maximum),
    available: creditAmount(details.available),
  };
}

function buildQuota(quota: GrazieQuotaResponse | undefined, refill: GrazieRefillResponse | undefined): QuotaSummary | undefined {
  const current = quota?.current;
  if (!current) return undefined;

  const tariff = quotaDetails(current.tariffQuota);
  const topUp = quotaDetails(current.topUpQuota);
  const buckets = [tariff?.available, topUp?.available].filter((n): n is number => typeof n === "number");
  const available = buckets.length > 0 ? buckets.reduce((a, b) => a + b, 0) : undefined;

  return {
    license: current.license,
    spent: creditAmount(current.current),
    maximum: creditAmount(current.maximum),
    available,
    until: current.until,
    tariff,
    topUp,
    refill: refill?.current && {
      next: refill.current.next,
      last: refill.current.last,
      amount: creditAmount(refill.current.tariff?.amount),
      periodMs: refill.current.tariff?.period?.millis,
    },
  };
}

async function handleBalance(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // Use explicitly provided auth, or fall back to last seen auth from chat requests
  const auth = getAuthHeader(req) || state.lastAuthHeader;
  if (!auth) {
    sendJson(res, 401, { error: { message: "No auth token available — run /login in Pi", type: "auth_error" } });
    return;
  }

  // Status-bar polls only need balanceLeft/balanceUnit; refill metadata is only
  // rendered in the /junie overlay (?full=1).
  const wantsRefill = url.searchParams.get("full") === "1";

  try {
    // Run concurrently — the quota calls cost ~1s each, and waiting for
    // /auth/test first would make /junie feel sluggish.
    const [test, quota, refill] = await Promise.all([
      proxyFetch(`${GRAZIE_AUTH_BASE}/auth/test`, {
        headers: grazieUserHeaders(auth),
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      }),
      grazieQuotaPost<GrazieQuotaResponse>(auth, "/user/v5/quota/get").catch(() => undefined),
      wantsRefill
        ? grazieQuotaPost<GrazieRefillResponse>(auth, "/user/v5/quota/metadata/refill").catch(() => undefined)
        : undefined,
    ]);
    if (!test.ok) {
      // Pass the upstream detail through — "no active licence" and "token
      // expired" are very different problems for the user.
      const body = (await test.text().catch(() => "")).trim();
      let detail = body.slice(0, 200);
      try { detail = JSON.parse(body).message ?? detail; } catch { /* not JSON — use the raw body */ }
      sendJson(res, test.status, {
        error: {
          message: `Balance check failed: HTTP ${test.status}${detail ? ` — ${detail}` : ""}`,
          type: "upstream_error",
        },
      });
      return;
    }
    const info = (await test.json()) as AuthTestResponse;
    const details = buildQuota(quota, refill);

    sendJson(res, 200, {
      // licenseType (TRIAL / AIP / AIPU / …) exists only on /auth/test
      balanceLeft: details?.available ?? info.balanceLeft,
      balanceUnit: info.balanceUnit,
      licenseType: info.licenseType,
      active: info.active,
      quota: details,
    });
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

export interface ConnTestResult {
  proxy: string | null;
  proxyAuth: string;
  nodeVersion: string;
  upstream: string;
  tests: Record<string, { ok: boolean; status?: number; addresses?: string[]; error?: string }>;
}

async function handleConnTest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const diag = getProxyDiagnostics();
  const result: ConnTestResult = {
    proxy: diag.proxy,
    proxyAuth: diag.auth,
    nodeVersion: process.version,
    upstream: UPSTREAM_BASE,
    tests: {},
  };

  // Test 1: DNS resolution (uses OS resolver so /etc/hosts, IPv6, and split-DNS work)
  try {
    const host = new URL(UPSTREAM_BASE).hostname;
    const addrs = await dns.lookup(host, { all: true });
    result.tests.dns = { ok: true, addresses: addrs.map((a) => a.address) };
  } catch (e) {
    result.tests.dns = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // Test 2: HTTPS fetch through proxy
  try {
    const r = await proxyFetch(UPSTREAM_BASE, {
      method: "GET",
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
    await r.body?.cancel().catch(() => {});
    result.tests.fetch = { ok: true, status: r.status };
  } catch (e) {
    result.tests.fetch = { ok: false, error: extractErrorMessage(e) };
  }

  // Behind a corporate proxy, the proxy resolves DNS on our behalf via CONNECT,
  // so local DNS failure alone does not mean connectivity is broken.
  const allOk = diag.proxy
    ? Boolean(result.tests.fetch?.ok)
    : Object.values(result.tests).every((t) => t.ok);
  sendJson(res, allOk ? 200 : 502, result);
}

// ─── Server ─────────────────────────────────────────────────────────────────

interface StartedServer {
  server: Server;
  port: number;
}

async function startServer(): Promise<StartedServer> {
  const server = createServer(async (req, res) => {
    // The proxy only ever talks to Pi on loopback. Rejecting foreign Host
    // headers (DNS rebinding) and sending no CORS headers keeps web pages open
    // in a browser from reaching /junie/balance and its cached credentials.
    if (!LOOPBACK_HOST_RE.test(req.headers.host ?? "")) {
      sendJson(res, 403, { error: { message: "Forbidden host", type: "forbidden" } });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      await handleResponses(req, res);
    } else if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChatCompletions(req, res);
    } else if (req.method === "POST" && path === "/v1/messages") {
      await handleMessages(req, res);
    } else if (req.method === "POST" && path.startsWith("/google/")) {
      await handleGoogle(req, res, url);
    } else if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      handleModels(req, res);
    } else if (req.method === "GET" && path === "/junie/balance") {
      await handleBalance(req, res, url);
    } else if (req.method === "GET" && path === "/junie/test") {
      await handleConnTest(req, res);
    } else if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pi-junie proxy — running");
    } else {
      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    }
  });

  const { promise: listening, resolve: onListening, reject: onListenError } = Promise.withResolvers<number>();
  server.once("error", onListenError);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      onListenError(new Error("Proxy server has no TCP address"));
      return;
    }
    onListening(address.port);
  });
  const port = await listening;

  return { server, port };
}

// ─── Shared server ──────────────────────────────────────────────────────────
//
// Pi builds a fresh extension instance for every session — including each
// subagent — but they all register "junie" on one shared model registry, and
// the last registration wins. If every instance owned its own server, a
// subagent finishing would close the very port the registry still points at,
// and the next Junie request from the main session would die with "Connection
// error." until the extension was reloaded. So the process shares one server,
// reference-counted, and it only closes once the last instance is gone.
const SHARED = Symbol.for("pi-jetbrains-junie-bridge.server");

interface SharedServer {
  refs: number;
  ready: Promise<StartedServer>;
}

/** A handle on the process-wide proxy; call `release` when the session ends. */
export interface ServerLease {
  port: number;
  release: () => void;
}

export async function acquireServer(): Promise<ServerLease> {
  const shared = globalThis as unknown as Record<symbol, SharedServer | undefined>;
  let entry = shared[SHARED];
  if (!entry) {
    const created: SharedServer = { refs: 0, ready: startServer() };
    entry = created;
    shared[SHARED] = created;
    created.ready.catch(() => {
      if (shared[SHARED] === created) delete shared[SHARED];
    });
  }
  const lease = entry;
  lease.refs++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--lease.refs > 0) return;
    if (shared[SHARED] === lease) delete shared[SHARED];
    lease.ready.then(({ server }) => {
      server.close();
      server.closeIdleConnections?.();
    }, () => {});
  };

  try {
    const { port } = await lease.ready;
    return { port, release };
  } catch (e) {
    release();
    throw e;
  }
}
