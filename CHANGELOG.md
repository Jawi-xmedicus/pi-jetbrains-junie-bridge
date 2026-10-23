# Changelog

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
