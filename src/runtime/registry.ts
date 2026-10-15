import { object, type JsonObject, type RegisteredModel } from "./types.js";

/**
 * Profiles are native Codex config, not another credential store. Only model
 * tuning is copied: selecting a profile in the picker must not change security,
 * permissions, instructions, MCP servers, or other unrelated profile settings.
 */
const MODEL_OPTIONS = [
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
] as const;

const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export function readProfiles(config: JsonObject): Map<string, RegisteredModel> {
  const providers = object(config.model_providers) ?? {};
  const profiles = object(config.profiles) ?? {};
  const models = new Map<string, RegisteredModel>();

  for (const [name, value] of Object.entries(profiles).sort()) {
    const profile = object(value);
    if (
      typeof profile?.model !== "string" ||
      typeof profile.model_provider !== "string" ||
      profile.model_provider === "openai"
    ) {
      continue;
    }

    const provider = object(providers[profile.model_provider]);
    if (!provider) {
      throw new Error(
        `[desktop-providers] Profile ${name} references an undefined provider: ${profile.model_provider}`,
      );
    }
    if (provider.wire_api !== "responses") {
      throw new Error(
        `[desktop-providers] Provider ${profile.model_provider} must use wire_api = "responses"; this patch does not translate API protocols`,
      );
    }
    const model = profile.model.trim();
    if (!model) {
      throw new Error(`[desktop-providers] Profile ${name} has an empty model`);
    }
    if (models.has(model)) {
      throw new Error(
        `[desktop-providers] Model ${model} occurs in multiple profiles; use a unique model ID per registered profile`,
      );
    }
    const effort = profile.model_reasoning_effort ?? "medium";
    if (typeof effort !== "string" || !EFFORTS.has(effort)) {
      throw new Error(
        `[desktop-providers] Invalid reasoning effort in ${name}`,
      );
    }
    const tuning: JsonObject = {};
    for (const key of MODEL_OPTIONS) {
      if (profile[key] !== undefined && profile[key] !== null) {
        tuning[key] = profile[key];
      }
    }
    // Never inherit an official model's ultra effort when starting this model.
    tuning.model_reasoning_effort = effort;
    models.set(model, {
      profile: name,
      model,
      provider: profile.model_provider,
      providerName:
        typeof provider.name === "string"
          ? provider.name
          : profile.model_provider,
      effort,
      config: tuning,
    });
  }
  return models;
}

const MARKER = "codexDesktopProvider";

export function isRegisteredModel(value: unknown): boolean {
  return typeof object(value)?.[MARKER] === "string";
}

export function appendModels(
  response: JsonObject,
  models: Map<string, RegisteredModel>,
  params?: JsonObject | null,
): JsonObject {
  if (!Array.isArray(response.data)) return response;
  // Detect collisions on every native page, not only the appended final page.
  for (const value of response.data) {
    const id = object(value)?.model;
    if (typeof id === "string" && models.has(id)) {
      throw new Error(
        `[desktop-providers] Model ${id} also occurs in the native catalog; ambiguous provider routing is not supported`,
      );
    }
  }
  // Append once, on the final native page. Keep native pagination unchanged.
  if (response.nextCursor != null) return response;
  const additions = [...models.values()].map((entry) => {
    return {
      id: entry.model,
      model: entry.model,
      displayName: `${entry.model} (${entry.providerName})`,
      description: `Direct connection via ${entry.provider}; profile: ${entry.profile}`,
      hidden: false,
      isDefault: false,
      supportsPersonality: false,
      // Conservative picker metadata; inference capabilities remain the native
      // backend/provider's responsibility, not an invented copy of GPT metadata.
      inputModalities: ["text"],
      supportedReasoningEfforts: [
        {
          reasoningEffort: entry.effort,
          description: `${entry.effort} effort`,
        },
      ],
      defaultReasoningEffort: entry.effort,
      upgrade: null,
      [MARKER]: entry.provider,
    };
  });
  // params is accepted to keep this function aligned with the request contract.
  void params;
  return { ...response, data: [...response.data, ...additions] };
}
