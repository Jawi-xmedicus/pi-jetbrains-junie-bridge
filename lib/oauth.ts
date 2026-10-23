/**
 * JetBrains Junie OAuth PKCE flow — adapted for Pi's OAuthLoginCallbacks.
 *
 * Extracted from server.ts. Instead of printing URLs and opening the browser
 * directly, this uses Pi's callbacks (onAuth, signal) so Pi controls the UI.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { proxyFetch } from "./proxy.ts";

const OAUTH = {
  tokenEndpoint: "https://oauth.account.jetbrains.com/oauth2/token",
  loginInitialUrl: "https://junie.jetbrains.com/cli-auth",
  clientId: "junie-cli",
  scopes: "offline_access openid jb-authn-service",
  callbackPortStart: 62345,
  callbackPortEnd: 62364,
};

/** What the token endpoint returns (only the fields the bridge reads). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

// Login/refresh shapes come straight from pi's provider registration contract,
// so a change there fails the typecheck here. Type-only: erased at runtime.
type PiOAuth = NonNullable<ProviderConfig["oauth"]>;
type LoginCallbacks = Parameters<PiOAuth["login"]>[0];
type OAuthCredentials = Awaited<ReturnType<PiOAuth["login"]>>;

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function getJwtExpiresIn(token: string): number | undefined {
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (parts.length !== 3 || payloadPart === undefined) return undefined;
    let payload = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const json = Buffer.from(payload, "base64").toString("utf-8");
    const claims = JSON.parse(json);
    if (typeof claims.exp !== "number") return undefined;
    return Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
  } catch { return undefined; }
}

async function startCallbackServer(signal?: AbortSignal) {
  const { promise: callbackPromise, resolve: resolveCallback, reject: rejectCallback } =
    Promise.withResolvers<{ code: string; state: string }>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code");
    const reqState = url.searchParams.get("state");
    const error = url.searchParams.get("error") ?? url.searchParams.get("error_description");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>");
      rejectCallback(new Error(`OAuth error: ${error}`));
      return;
    }
    if (code && reqState) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authentication Successful</h1><p>You can close this window and return to Pi.</p></body></html>");
      resolveCallback({ code, state: reqState });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Respect abort signal
  if (signal) {
    signal.addEventListener("abort", () => {
      rejectCallback(new Error("Login aborted"));
      server.close();
    }, { once: true });
  }

  const { promise: portReady, resolve: resolvePort, reject: rejectPort } = Promise.withResolvers<number>();
  let current = OAUTH.callbackPortStart;
  const tryPort = () => {
    if (current > OAUTH.callbackPortEnd) {
      rejectPort(new Error(`Cannot start OAuth callback server on ports ${OAUTH.callbackPortStart}-${OAUTH.callbackPortEnd}`));
      return;
    }
    server.once("error", () => { current++; tryPort(); });
    server.listen(current, "localhost", () => resolvePort(current));
  };
  tryPort();
  const port = await portReady;

  return { server, port, waitForCallback: () => callbackPromise };
}

function buildAuthUrl(port: number, codeChallenge: string, authState: string): string {
  const redirectUri = `http://localhost:${port}`;
  return `${OAUTH.loginInitialUrl}?client_id=${OAUTH.clientId}&scope=${encodeURIComponent(OAUTH.scopes)}&state=${authState}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

async function exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: OAUTH.clientId,
    redirect_uri: redirectUri,
  });
  const res = await proxyFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

/** Pi-compatible OAuth login function. */
export async function junieLogin(callbacks: LoginCallbacks): Promise<OAuthCredentials> {
  const pkce = generatePKCE();
  const authState = randomBytes(16).toString("hex");
  const { server, port, waitForCallback } = await startCallbackServer(callbacks.signal);
  const redirectUri = `http://localhost:${port}`;
  const authUrl = buildAuthUrl(port, pkce.codeChallenge, authState);
  try {
    // Tell Pi to show the URL and open the browser
    callbacks.onAuth({ url: authUrl });

    const callback = await waitForCallback();
    if (callback.state !== authState) throw new Error("OAuth state mismatch");

    const tokenResponse = await exchangeCodeForToken(callback.code, pkce.codeVerifier, redirectUri);

    let expiresIn = tokenResponse.expires_in;
    if (!expiresIn && tokenResponse.access_token) {
      expiresIn = getJwtExpiresIn(tokenResponse.access_token);
    }
    const expiresMs = expiresIn
      ? Date.now() + expiresIn * 1000 - 60 * 1000 // 60s safety margin
      : Date.now() + 3600 * 1000; // fallback 1h

    if (!tokenResponse.refresh_token) throw new Error("Token response contained no refresh_token");

    return {
      access: tokenResponse.access_token,
      refresh: tokenResponse.refresh_token,
      expires: expiresMs,
    };
  } finally {
    server.close();
  }
}

/** Pi-compatible OAuth token refresh function. */
export async function junieRefreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: OAUTH.clientId,
  });
  const res = await proxyFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as TokenResponse;

  let expiresIn = data.expires_in;
  if (!expiresIn && data.access_token) {
    expiresIn = getJwtExpiresIn(data.access_token);
  }
  const expiresMs = expiresIn
    ? Date.now() + expiresIn * 1000 - 60 * 1000
    : Date.now() + 3600 * 1000;

  return {
    access: data.access_token,
    refresh: data.refresh_token ?? credentials.refresh,
    expires: expiresMs,
  };
}
