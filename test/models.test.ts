import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWN_GRAZIE_MODELS,
  buildProviderModels,
  isLegacyModel,
  upstreamModelId,
  type ProviderType,
} from "../lib/models.ts";

const TYPES: ProviderType[] = ["openai", "claude", "grok", "gemini"];
const PORT = 4242;

describe("model table", () => {
  it("maps every OpenAI and Grok model to a different upstream name", () => {
    // Pi-facing IDs are dash-normalised ("gpt-6-1-sol"); Grazie wants dots
    // ("gpt-6.1-sol"). A model added without `upstream` would be sent as-is and
    // rejected only by the backend.
    const unmapped = KNOWN_GRAZIE_MODELS
      .filter((id) => id.startsWith("openai-") || id.startsWith("grok-"))
      .filter((id) => upstreamModelId(id) === id);
    assert.deepEqual(unmapped, []);
  });

  it("sends Claude and Gemini IDs upstream verbatim", () => {
    for (const id of KNOWN_GRAZIE_MODELS.filter((m) => m.startsWith("claude-") || m.startsWith("gemini-"))) {
      assert.equal(upstreamModelId(id), id);
    }
  });

  it("passes unknown IDs through untouched", () => {
    assert.equal(upstreamModelId("not-a-model"), "not-a-model");
  });

  it("registers each non-legacy model exactly once across the four families", () => {
    const registered = TYPES.flatMap((t) => buildProviderModels(t, PORT).map((m) => m.id));
    const expected = KNOWN_GRAZIE_MODELS.filter((id) => !isLegacyModel(id));
    assert.deepEqual([...registered].sort(), [...expected].sort());
  });
});

describe("provider model routing", () => {
  it("points Claude at the bridge root over the Anthropic API", () => {
    for (const m of buildProviderModels("claude", PORT)) {
      assert.equal(m.api, "anthropic-messages");
      assert.equal(m.baseUrl, `http://localhost:${PORT}`);
    }
  });

  it("points Gemini at the /google route over the Google API", () => {
    for (const m of buildProviderModels("gemini", PORT)) {
      assert.equal(m.api, "google-generative-ai");
      assert.equal(m.baseUrl, `http://localhost:${PORT}/google/v1beta`);
    }
  });

  it("uses the Responses API for OpenAI and Grok so reasoning effort works with tools", () => {
    for (const type of ["openai", "grok"] as const) {
      for (const m of buildProviderModels(type, PORT)) {
        assert.equal(m.api, "openai-responses");
        assert.ok(m.thinkingLevelMap, `${m.id} has no thinkingLevelMap`);
      }
    }
  });

  it("maps Pi's 'off' to the lowest effort Grok accepts, but to 'none' for OpenAI", () => {
    // Grok rejects reasoning effort "none".
    assert.equal(buildProviderModels("grok", PORT)[0]?.thinkingLevelMap?.off, "minimal");
    assert.equal(buildProviderModels("openai", PORT)[0]?.thinkingLevelMap?.off, "none");
  });
});
