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

const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const EFFORTS = new Set<string>(EFFORT_ORDER);

/** Native config normalization drops extension metadata. Layers arrive in
 * highest-precedence-first order; only enabled, non-project layers can supply
 * names. Routing and authentication still come from native effective config. */
function profileNames(layers: unknown): Map<string, unknown> {
  const names = new Map<string, unknown>();
  if (!Array.isArray(layers)) return names;
  for (const value of layers) {
    const layer = object(value);
    if (
      !layer ||
      layer.disabledReason != null ||
      object(layer.name)?.type === "project"
    )
      continue;
    const profiles = object(object(layer.config)?.profiles) ?? {};
    for (const [name, value] of Object.entries(profiles)) {
      const profile = object(value);
      if (profile && Object.hasOwn(profile, "model_name") && !names.has(name)) {
        names.set(name, profile.model_name);
      }
    }
  }
  return names;
}

function modelName(value: unknown, profile: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `[desktop-providers] model_name in profile ${profile} must be a non-empty string`,
    );
  }
  return value.trim();
}

export function readProfiles(
  config: JsonObject,
  layers?: unknown,
): Map<string, RegisteredModel> {
  const providers = object(config.model_providers) ?? {};
  const profiles = object(config.profiles) ?? {};
  const models = new Map<string, RegisteredModel>();
  const names = profileNames(layers);

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
    const displayName = modelName(profile.model_name ?? names.get(name), name);
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
    const previous = models.get(model);
    if (previous) {
      if (previous.provider !== profile.model_provider) {
        throw new Error(
          `[desktop-providers] Model ${model} occurs on multiple providers; its routing would be ambiguous`,
        );
      }
      if (displayName !== undefined) {
        if (
          previous.modelName !== undefined &&
          previous.modelName !== displayName
        ) {
          throw new Error(
            `[desktop-providers] Conflicting model_name for ${model} in profiles ${previous.profile} and ${name}`,
          );
        }
        previous.modelName = displayName;
      }
      for (const [key, value] of Object.entries(tuning)) {
        if (key === "model_reasoning_effort") continue;
        if (
          previous.config[key] !== undefined &&
          previous.config[key] !== value
        ) {
          throw new Error(
            `[desktop-providers] Conflicting ${key} for ${model} in profiles ${previous.profile} and ${name}`,
          );
        }
        previous.config[key] = value;
      }
      previous.efforts = EFFORT_ORDER.filter(
        (value) => value === effort || previous.efforts.includes(value),
      );
      continue;
    }
    models.set(model, {
      profile: name,
      model,
      ...(displayName === undefined ? {} : { modelName: displayName }),
      provider: profile.model_provider,
      providerName:
        typeof provider.name === "string"
          ? provider.name
          : profile.model_provider,
      effort,
      efforts: [effort],
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
      displayName: `${entry.modelName ?? entry.model} (${entry.providerName})`,
      description: `${entry.modelName ?? entry.model} via ${entry.providerName}`,
      hidden: false,
      isDefault: false,
      supportsPersonality: false,
      // Conservative picker metadata; inference capabilities remain the native
      // backend/provider's responsibility, not an invented copy of GPT metadata.
      inputModalities: ["text"],
      supportedReasoningEfforts: entry.efforts.map((reasoningEffort) => ({
        reasoningEffort,
        description: `${reasoningEffort} effort`,
      })),
      defaultReasoningEffort: entry.effort,
      upgrade: null,
      [MARKER]: entry.provider,
    };
  });
  // params is accepted to keep this function aligned with the request contract.
  void params;
  return { ...response, data: [...response.data, ...additions] };
}

/** Native account-level effort toggles apply to native models. For explicitly
 * registered models the native profile declarations are the capability list. */
export function restorePickerEfforts(
  result: JsonObject,
  catalog: unknown[],
): JsonObject {
  if (!Array.isArray(result.models)) return result;
  const registered = new Map(
    catalog.flatMap((value) => {
      const model = object(value);
      return isRegisteredModel(model) ? [[model!.model, model!] as const] : [];
    }),
  );
  if (!registered.size) return result;
  const models = result.models.map((value) => {
    const model = object(value);
    const source = registered.get(model?.model);
    return source
      ? {
          ...model,
          supportedReasoningEfforts: source.supportedReasoningEfforts,
          defaultReasoningEffort: source.defaultReasoningEffort,
        }
      : value;
  });
  const defaultId = object(result.defaultModel)?.model;
  return {
    ...result,
    models,
    defaultModel:
      defaultId === undefined
        ? result.defaultModel
        : (models.find((value) => object(value)?.model === defaultId) ??
          result.defaultModel),
    hasModelSupportingMaxReasoningEffort:
      result.hasModelSupportingMaxReasoningEffort === true ||
      [...registered.values()].some((model) =>
        (model.supportedReasoningEfforts as JsonObject[]).some(
          (entry) => entry.reasoningEffort === "max",
        ),
      ),
    hasModelSupportingUltraReasoningEffort:
      result.hasModelSupportingUltraReasoningEffort === true ||
      [...registered.values()].some((model) =>
        (model.supportedReasoningEfforts as JsonObject[]).some(
          (entry) => entry.reasoningEffort === "ultra",
        ),
      ),
  };
}
