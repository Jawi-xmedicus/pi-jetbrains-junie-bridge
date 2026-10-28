/**
 * Junie model definitions for Pi extension provider registration.
 *
 * KNOWN_GRAZIE_MODELS: master list of Grazie model IDs (from Junie CLI v3659.7).
 * buildProviderModels(): builds ProviderModelConfig[] for pi.registerProvider().
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Junie CLI build the list was extracted from: v3659.7 (2026-10-16); all new
// models verified live against the Grazie backend.
// Routing by prefix: claude-* → anthropic passthrough, openai-*/grok-* → OpenAI
// Responses API passthrough (grok- with X-LLM-Model: grok), gemini-* → Google
// generateContent passthrough (X-LLM-Model: google).
//
// `upstream` is the model name Grazie expects when it differs from the Pi-facing
// ID (Pi IDs are dash-normalised). Everything about a model lives in this one
// table — add a model here and nowhere else.
const CLAUDE = { reasoning: true, contextWindow: 1000000, maxTokens: 128000 };
const OPENAI = { reasoning: true, contextWindow: 1000000, maxTokens: 32768 };
const GROK   = { reasoning: true, contextWindow: 500000,  maxTokens: 32768 };
// Google IDs keep their upstream form verbatim (dots included): pi-ai picks the
// Gemini 3+ `thinkingLevel` API over the old `thinkingBudget` API by matching
// the model ID (/gemini-3(\.\d+)?-(pro|flash)/, /gemini-[4-9]/), and a
// dash-normalised ID would silently fall back to the budget API.
// None of them can disable thinking, so "off" is null (unsupported); without a
// map Pi would offer "off" and send `thinkingBudget: 0`, which the backend
// rejects. Only some models accept MINIMAL (maps mirror pi-ai's google catalog).
const GEMINI_LEVELS = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as const;
const GEMINI = { reasoning: true, contextWindow: 1048576, maxTokens: 65536, thinkingLevelMap: GEMINI_LEVELS };
const GEMINI_MINIMAL = { ...GEMINI, thinkingLevelMap: { ...GEMINI_LEVELS, minimal: "minimal" } };

interface ModelMeta {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Name Grazie expects, when it differs from the Pi-facing ID. */
  upstream?: string;
  /** Pi thinking level → provider level; null marks a level as unsupported. */
  thinkingLevelMap?: NonNullable<ProviderModelConfig["thinkingLevelMap"]>;
}

const MODELS = {
  // Anthropic — passthrough via ingrazzio-cloud-prod /v1/messages
  "claude-sonnet-4-6":    CLAUDE,
  "claude-sonnet-5":      CLAUDE,
  "claude-sonnet-5-5":    CLAUDE,
  "claude-haiku-5-5":     { ...CLAUDE, maxTokens: 64000 },
  "claude-haiku-5":       CLAUDE,
  "claude-opus-4-6":      CLAUDE,
  "claude-opus-4-7":      CLAUDE,
  "claude-opus-4-8":      CLAUDE,
  "claude-opus-5":        CLAUDE,
  "claude-opus-5-5":      CLAUDE,
  "claude-fable-5":       CLAUDE,
  "claude-fable-5-1":     CLAUDE,

  // OpenAI — passthrough via ingrazzio-cloud-prod /v1/responses (OpenAI Responses API)
  "openai-gpt-5-2":       { ...OPENAI, upstream: "gpt-5.2", contextWindow: 400000 },
  "openai-gpt-5-4":       { ...OPENAI, upstream: "gpt-5.4" },
  "openai-gpt-5-5":       { ...OPENAI, upstream: "gpt-5.5" },
  "openai-gpt-5-6-luna":  { ...OPENAI, upstream: "gpt-5.6-luna" },
  "openai-gpt-5-6-terra": { ...OPENAI, upstream: "gpt-5.6-terra" },
  "openai-gpt-5-6-sol":   { ...OPENAI, upstream: "gpt-5.6-sol" },
  "openai-gpt-6-astra":   { ...OPENAI, upstream: "gpt-6-astra" },
  "openai-gpt-6-luna":    { ...OPENAI, upstream: "gpt-6-luna" },
  "openai-gpt-6-sol":     { ...OPENAI, upstream: "gpt-6-sol" },
  "openai-gpt-6-1-sol":   { ...OPENAI, upstream: "gpt-6.1-sol" },

  // xAI — passthrough via ingrazzio-cloud-prod /v1/responses with X-LLM-Model: grok
  "grok-4-3":             { ...GROK, upstream: "grok-4.3", contextWindow: 1000000 },
  "grok-4-5":             { ...GROK, upstream: "grok-4.5" },
  "grok-4-6":             { ...GROK, upstream: "grok-4.6" },
  "grok-4-7":             { ...GROK, upstream: "grok-4.7" },

  // Google — passthrough via the Vertex-style generateContent path with
  // X-LLM-Model: google.
  "gemini-3-flash-preview":  GEMINI_MINIMAL,
  "gemini-3.1-pro-preview":  GEMINI,
  "gemini-3.1-flash-lite":   GEMINI_MINIMAL,
  "gemini-3.5-flash":        GEMINI_MINIMAL,
  "gemini-3.5-flash-lite":   GEMINI_MINIMAL,
  "gemini-3.6-flash":        GEMINI_MINIMAL,
  "gemini-3.7-flash":        GEMINI,
  "gemini-3.8-flash":        GEMINI,
  "gemini-4-argon":          GEMINI,
} satisfies Record<string, ModelMeta>;

type ModelId = keyof typeof MODELS;
export type ProviderType = "openai" | "claude" | "grok" | "gemini";

export const KNOWN_GRAZIE_MODELS: string[] = Object.keys(MODELS);

/** The model name Grazie expects for a Pi-facing ID. */
export function upstreamModelId(id: string): string {
  const meta: ModelMeta | undefined = MODELS[id as ModelId];
  return meta?.upstream ?? id;
}

export function isLegacyModel(id: string): boolean {
  if (/^openai-gpt-?5(-mini|-nano|-codex)?$/.test(id)) return true;
  if (/^openai-gpt-?4/.test(id)) return true;
  if (/^openai-o[1234]/.test(id)) return true;
  if (/^claude-(sonnet|opus)-4-0/.test(id)) return true;
  if (/^claude-3-/.test(id)) return true;
  return false;
}

// Compat flags per provider type
const OPENAI_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: false,
};

// Maps Pi's thinking levels to the Grazie/OpenAI ReasoningEffort enum values
// (minimal|low|medium|high|xhigh|none). Sending `reasoning.effort` is only
// accepted by the Grazie backend on the OpenAI Responses API (/v1/responses),
// never on /v1/chat/completions when function tools are present.
const OPENAI_THINKING_LEVEL_MAP: Record<string, string> = {
  off:     "none",
  minimal: "minimal",
  low:     "low",
  medium:  "medium",
  high:    "high",
  xhigh:   "xhigh",
  max:     "xhigh",
};

// Grok rejects `reasoning_effort: none` ("This model does not support
// `reasoning_effort` value `none`."), so Pi's "off" maps to the lowest effort
// the model accepts instead of disabling reasoning.
const GROK_THINKING_LEVEL_MAP: Record<string, string> = {
  ...OPENAI_THINKING_LEVEL_MAP,
  off: "minimal",
};

// Anthropic separates thinking (adaptive here, via forceAdaptiveThinking) from
// output_config.effort. Pi's single thinking slider maps onto effort. Pi hides
// xhigh/max unless they are present in thinkingLevelMap (otherwise it clamps to
// high), so each model lists exactly the extra levels it accepts. Fable cannot
// disable thinking (off -> HTTP 400), so its "off" is null (unsupported).
// Keyed by every Claude model id in MODELS: a missing id is a type error.
type ClaudeModelId = Extract<ModelId, `claude-${string}`>;
const XHIGH_MAX = { xhigh: "xhigh", max: "max" } as const;
const MAX_ONLY = { max: "max" } as const;
const FABLE = { off: null, ...XHIGH_MAX } as const;
export const CLAUDE_THINKING_LEVEL_MAP: Record<ClaudeModelId, NonNullable<ProviderModelConfig["thinkingLevelMap"]>> = {
  "claude-sonnet-4-6": MAX_ONLY,
  "claude-sonnet-5":   XHIGH_MAX,
  "claude-sonnet-5-5": XHIGH_MAX,
  "claude-haiku-5-5":  {},
  "claude-haiku-5":    {},
  "claude-opus-4-6":   MAX_ONLY,
  "claude-opus-4-7":   XHIGH_MAX,
  "claude-opus-4-8":   XHIGH_MAX,
  "claude-opus-5":     XHIGH_MAX,
  "claude-opus-5-5":   XHIGH_MAX,
  "claude-fable-5":    FABLE,
  "claude-fable-5-1":  FABLE,
};

const CLAUDE_COMPAT = {
  forceAdaptiveThinking: true,
  supportsEagerToolInputStreaming: false,
  supportsLongCacheRetention: false,
};

const PREFIX_BY_TYPE: Record<ProviderType, string> = {
  claude: "claude-",
  grok:   "grok-",
  gemini: "gemini-",
  openai: "openai-",
};

/**
 * Build ProviderModelConfig[] for pi.registerProvider().
 * OpenAI and Grok models override api to "openai-responses" (Responses API) so
 * reasoning effort can be combined with function tools; they inherit
 * provider-level baseUrl. Claude and Gemini models get per-model overrides
 * (api + baseUrl), since both speak their own protocol on their own route.
 * @param port — per-model baseUrl override for claude/gemini
 */
export function buildProviderModels(type: ProviderType, port: number): ProviderModelConfig[] {
  const prefix = PREFIX_BY_TYPE[type];
  // Gemini goes through pi-ai's Google client, which ignores the OpenAI/Claude
  // compat flags — leave them off rather than sending misleading ones.
  const compat = type === "claude" ? CLAUDE_COMPAT : type === "gemini" ? undefined : OPENAI_COMPAT;

  return KNOWN_GRAZIE_MODELS
    .filter((id) => id.startsWith(prefix) && !isLegacyModel(id))
    .map((id) => {
      const meta = MODELS[id as ModelId];
      const model: ProviderModelConfig = {
        id,
        name: id + " (Junie)",
        reasoning: meta.reasoning,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
        ...(compat && { compat }),
      };
      if (type === "claude") {
        model.api = "anthropic-messages";
        model.baseUrl = `http://localhost:${port}`;
        model.thinkingLevelMap = CLAUDE_THINKING_LEVEL_MAP[id as ClaudeModelId];
      } else if (type === "gemini") {
        // pi-ai drives these with the @google/genai SDK, which appends
        // /models/<id>:generateContent to the baseUrl. The bridge rewrites that
        // onto the Grazie Vertex path (see handleGoogle in server.ts).
        model.api = "google-generative-ai";
        model.baseUrl = `http://localhost:${port}/google/v1beta`;
        model.thinkingLevelMap = (meta as ModelMeta).thinkingLevelMap;
      } else {
        // OpenAI / Grok: use the Responses API so `reasoning.effort` is honoured
        // together with function tools. baseUrl is inherited from the provider.
        model.api = "openai-responses";
        model.thinkingLevelMap = type === "grok" ? GROK_THINKING_LEVEL_MAP : OPENAI_THINKING_LEVEL_MAP;
      }
      return model;
    });
}
