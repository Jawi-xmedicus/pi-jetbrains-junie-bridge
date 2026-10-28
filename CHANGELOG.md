# Changelog

## Unreleased

### Fixed
- `/junie` and the status line could show a different licence than chat consumes. `/auth/test` and the QuotaAPI calls now send `X-Accept-EAP-License: false` like chat does; without it Grazie prefers `JUNP` (USD, EAP) over `AIP`/`AIPU` (credits). Port of upstream PR #6.
- Claude models: Pi's thinking slider clamped `xhigh`/`max` to `high`, and `off` on Fable and Claude 5.5 Opus/Sonnet models answered 400. Claude models now declare a per-model `thinkingLevelMap` (slider → Anthropic `output_config.effort`; thinking stays adaptive), and `claude-haiku-5-5` now exposes `128k` `maxTokens` and `xhigh`/`max`. Port of upstream PR #6.
- Gemini, Grok, and GPT-6 models: `off` on Gemini 3/4, Grok, `openai-gpt-6-astra`, and `openai-gpt-6-1-sol` (plus `minimal` on `gemini-3.1-pro-preview`, `gemini-3.7-flash`, `gemini-3.8-flash`, and `gemini-4-argon`) is now marked `null` in `thinkingLevelMap` so unsupported levels are hidden and clamped while preserving reasoning summaries.
- Session starting balance (`startBalance`) and proxy state (`freeGoogleApi`, `lastAuthHeader`) now persist across `/reload` and session switches, and the loopback server is `unref()`ed so subagent sessions disposed without `session_shutdown` never block process exit.
- Subagents and headless sessions (`!ctx.hasUI`) no longer poll `/junie/balance` or reset `startBalance` on session start, and status-bar polls skip the `/user/v5/quota/metadata/refill` request (only fetched on `/junie`).
- `/junie/balance` falls back to `/auth/test` `balanceLeft` instead of reporting `$0.00` if `quota.current` omits `tariffQuota`/`topUpQuota`, and session usage is clamped so mid-session refills/top-ups never display `−$-…`.
- `/junie/test` enforces a timeout on the upstream fetch, uses the OS resolver (`dns.lookup`), and does not fail the overall check on local DNS failure when an HTTP proxy is configured.
- OAuth token exchange and refresh requests now honour abort signals and a 15s timeout, and SSE backpressure drains clean up their `close`/`drain` listeners.
- `/junie` overlay supports `q` to close, `PgUp`/`PgDn`/`Home`/`End`/`g`/`G` scrolling, ignores Kitty key-release events on Enter/Esc, avoids redundant re-renders when scrolling past the top/bottom, and splits/clamps long tokens so lines never exceed terminal width.

## 1.5.0

Fork of [sschatter/pi-jetbrains-junie-bridge](https://github.com/sschatter/pi-jetbrains-junie-bridge), maintained at [Jawi-xmedicus/pi-jetbrains-junie-bridge](https://github.com/Jawi-xmedicus/pi-jetbrains-junie-bridge). Distributed from GitHub only (not published to npm).

### Added
- Models from Junie CLI 3659.7: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-5`, `openai-gpt-6-luna`, `openai-gpt-6-sol`, `openai-gpt-6-1-sol`, `grok-4-7`, `gemini-4-argon`.
- `npm run typecheck` (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`) and `npm test`; CI runs both on push and pull requests, and the release workflow runs them before tagging a release.

### Changed
- `lib/*.mjs` is now TypeScript (`lib/*.ts`).
- All model facts live in one `MODELS` table in `lib/models.ts` (context window, output limit, upstream name). `KNOWN_GRAZIE_MODELS` and the ID mapping are derived from it.
- `engines.node` is now `>=22` (`Promise.withResolvers`); omp runs the extension on Bun.
- `junieLogin` fails with a clear error when the token response has no `refresh_token`, instead of storing unusable credentials.
- Release workflow only creates a GitHub release; it no longer publishes to npm.

### Fixed
- **"Connection error." after switching sessions or after subagents ran.** Every session and subagent started its own proxy, and the last one to register won the shared `junie` provider. When that session ended, the port the provider still pointed at was closed. The process now shares one reference-counted proxy.
- A 477 from Grazie did not retry: the request failed and only the next one went out without `X-Free-Google-Api`. It now repeats once, transparently.
- A stream that broke mid-response was ended cleanly, so Pi saw a truncated message with no cause. The connection is now cut, so the failure is reported (and retried).
- Aborting a turn (Esc) now cancels the upstream request instead of letting it run on.
- The abort signal (and thus the balance timeout) is honoured when going through an HTTP(S) proxy; failed tunnels no longer leak sockets.
- Invalid JSON, or a body without a string `model`, answers 400 instead of 500.
- The OAuth callback server is closed if `onAuth` throws.

### Security
- The proxy rejects requests whose `Host` is not loopback (DNS rebinding) and no longer sends CORS headers, so a web page can no longer read `/junie/balance`.

### Removed
- `cleanOldModelsJson`: it silently deleted `junie`, `junie-claude` and `junie-openai` providers from `~/.pi/agent/models.json` on every start. It was a one-off migration from the old `pi-junie setup`.
