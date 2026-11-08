import { object, type JsonObject, type RegisteredModel } from "./types.js";

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
const LEGACY_OPTIONS = [
  "model_name",
  "model_reasoning_efforts",
  "model_reasoning_effort",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_reasoning_summary",
  "model_verbosity",
];

/** Native profiles only bind catalog model IDs to providers. All model metadata
 * comes from the catalog already loaded by the native app-server. */
export function readProfiles(
  config: JsonObject,
  catalog: unknown[],
  layers?: unknown,
): Map<string, RegisteredModel> {
  const providers = object(config.model_providers) ?? {};
  const profiles = object(config.profiles) ?? {};
  const models = new Map<string, RegisteredModel>();
  for (const [name, value] of Object.entries(profiles).sort()) {
    const profile = object(value);
    if (
      typeof profile?.model !== "string" ||
      typeof profile.model_provider !== "string" ||
      profile.model_provider === "openai"
    )
      continue;
    const model = profile.model.trim();
    if (!model || model !== profile.model)
      throw new Error(
        `[desktop-providers] Profile ${name} must use an exact non-empty catalog model ID`,
      );
    if (models.has(model))
      throw new Error(
        `[desktop-providers] Model ${model} is registered by multiple profiles; declare one profile per model`,
      );
    const provider = object(providers[profile.model_provider]);
    if (!provider)
      throw new Error(
        `[desktop-providers] Profile ${name} references an undefined provider: ${profile.model_provider}`,
      );
    if (provider.wire_api !== "responses")
      throw new Error(
        `[desktop-providers] Provider ${profile.model_provider} must use wire_api = "responses"; this patch does not translate API protocols`,
      );
    if (config.model_provider != null && config.model_provider !== "openai")
      throw new Error(
        "[desktop-providers] Keep the global model_provider unset or openai; select external providers only for new chats",
      );
    if (config.model === model)
      throw new Error(
        `[desktop-providers] Keep an official model as the global default; ${model} is registered for an external provider`,
      );
    if (
      typeof config.model_catalog_json !== "string" ||
      !config.model_catalog_json.trim()
    )
      throw new Error(
        "[desktop-providers] Configure model_catalog_json at startup and restart the native app-server before using registered providers",
      );
    if (
      profile.model_catalog_json != null &&
      profile.model_catalog_json !== config.model_catalog_json
    )
      throw new Error(
        `[desktop-providers] Profile ${name} selects a different model_catalog_json; per-thread catalogs are not supported, use the startup catalog`,
      );
    const sources = [profile];
    if (Array.isArray(layers))
      for (const value of layers) {
        const layer = object(value);
        if (
          !layer ||
          layer.disabledReason != null ||
          object(layer.name)?.type === "project"
        )
          continue;
        const raw = object(object(object(layer.config)?.profiles)?.[name]);
        if (raw) sources.push(raw);
      }
    for (const source of sources)
      for (const key of LEGACY_OPTIONS)
        if (source[key] != null)
          throw new Error(
            `[desktop-providers] Move ${key} from profile ${name} into model_catalog_json; profiles only select model and model_provider`,
          );
    const matches = catalog
      .map(object)
      .filter((entry) => entry?.model === model);
    if (matches.length !== 1)
      throw new Error(
        `[desktop-providers] Expected exactly one native catalog entry for ${model}; found ${matches.length}. Check model_catalog_json and restart the native app-server`,
      );
    const metadata = matches[0]!;
    const efforts = Array.isArray(metadata.supportedReasoningEfforts)
      ? metadata.supportedReasoningEfforts.map(
          (item) => object(item)?.reasoningEffort,
        )
      : [];
    const effort = metadata.defaultReasoningEffort;
    if (
      !efforts.length ||
      efforts.some(
        (value) => typeof value !== "string" || !EFFORTS.has(value),
      ) ||
      new Set(efforts).size !== efforts.length ||
      typeof effort !== "string" ||
      !efforts.includes(effort)
    )
      throw new Error(
        `[desktop-providers] Catalog model ${model} must declare supported reasoning efforts and a default included in that list`,
      );
    if (
      typeof metadata.displayName !== "string" ||
      !metadata.displayName.trim()
    )
      throw new Error(
        `[desktop-providers] Catalog model ${model} must have a non-empty display name`,
      );
    models.set(model, {
      profile: name,
      model,
      provider: profile.model_provider,
      providerName:
        typeof provider.name === "string"
          ? provider.name
          : profile.model_provider,
      effort,
      efforts: efforts as string[],
    });
  }
  return models;
}

const MARKER = "codexDesktopProvider";

export function isRegisteredModel(value: unknown): boolean {
  return typeof object(value)?.[MARKER] === "string";
}

/** Decorate existing catalog entries in place. Never append fabricated metadata
 * or alter pagination, native entries, or their entitlement fields. */
export function decorateModels(
  response: JsonObject,
  models: Map<string, RegisteredModel>,
): JsonObject {
  if (!Array.isArray(response.data)) return response;
  return {
    ...response,
    data: response.data.map((value) => {
      const metadata = object(value);
      const entry = models.get(String(metadata?.model));
      return entry
        ? {
            ...metadata,
            displayName: `${metadata!.displayName} (${entry.providerName})`,
            isDefault: false,
            [MARKER]: entry.provider,
          }
        : value;
    }),
  };
}

/** Native account-level effort toggles apply to native models. For explicitly
 * registered models the native catalog declarations are the capability list. */
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
