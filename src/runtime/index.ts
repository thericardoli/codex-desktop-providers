import { decorateModels, isRegisteredModel, readProfiles } from "./registry.js";
import {
  object,
  type JsonObject,
  type Registry,
  type RegisteredModel,
  type RequestClient,
  type Sender,
} from "./types.js";

export { isRegisteredModel, restorePickerEfforts } from "./registry.js";

const registries = new WeakMap<RequestClient, Promise<Registry>>();
const CONFIG_CACHE_MS = 30_000;
const MAX_OBSERVED_THREADS = 512;
// Identity-scoped bypass for our own catalog reads. Concurrent UI requests still
// go through the interceptor; no global "loading" flag disables their guards.
const catalogRequests = new WeakSet<JsonObject>();

async function nativeCatalog(client: RequestClient): Promise<unknown[]> {
  const catalog: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const params: JsonObject = {
      includeHidden: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    };
    catalogRequests.add(params);
    let result;
    try {
      result = object(await client.sendRequest("model/list", params));
    } finally {
      catalogRequests.delete(params);
    }
    if (!Array.isArray(result?.data))
      throw new Error(
        "[desktop-providers] Native model/list returned no catalog",
      );
    catalog.push(...result.data);
    if (result.nextCursor == null) return catalog;
    if (
      typeof result.nextCursor !== "string" ||
      !result.nextCursor ||
      cursors.has(result.nextCursor) ||
      cursors.size >= 100
    )
      throw new Error(
        "[desktop-providers] Invalid native model catalog pagination",
      );
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
}

async function registry(client: RequestClient): Promise<Registry> {
  const previous = registries.get(client);
  if (previous) {
    const cached = await previous;
    if (Date.now() - cached.loadedAt < CONFIG_CACHE_MS) return cached;
  }
  const pending = (async () => {
    const result = object(
      await client.sendRequest("config/read", {
        includeLayers: true,
        cwd: null,
      }),
    );
    const config = object(result?.config);
    if (!config)
      throw new Error("[desktop-providers] config/read returned no config");
    const hasCustomProfiles = Object.values(object(config.profiles) ?? {}).some(
      (value) => {
        const profile = object(value);
        return (
          typeof profile?.model === "string" &&
          typeof profile.model_provider === "string" &&
          profile.model_provider !== "openai"
        );
      },
    );
    return {
      models: readProfiles(
        config,
        hasCustomProfiles ? await nativeCatalog(client) : [],
        result?.layers,
      ),
      threads: previous ? (await previous).threads : new Map<string, string>(),
      selections: previous
        ? (await previous).selections
        : new Map<string, string>(),
      loadedAt: Date.now(),
    };
  })();
  registries.set(client, pending);
  try {
    return await pending;
  } catch (error) {
    registries.delete(client);
    throw error;
  }
}

function observe(state: Registry, result: unknown): void {
  const thread = object(object(result)?.thread);
  if (
    typeof thread?.id !== "string" ||
    typeof thread.modelProvider !== "string"
  )
    return;
  state.threads.delete(thread.id);
  state.threads.set(thread.id, thread.modelProvider);
  if (state.threads.size > MAX_OBSERVED_THREADS) {
    const oldest = state.threads.keys().next().value;
    if (oldest !== undefined) state.threads.delete(oldest);
  }
}

function requestedModel(params?: JsonObject | null): string | undefined {
  const mode = object(params?.collaborationMode);
  const model = object(mode?.settings)?.model ?? params?.model;
  return typeof model === "string" ? model : undefined;
}

function requestedEffort(params: JsonObject): unknown {
  return (
    object(object(params.collaborationMode)?.settings)?.reasoning_effort ??
    params.effort ??
    object(params.config)?.model_reasoning_effort
  );
}

function supportedEffort(entry: RegisteredModel, value: unknown): string {
  return typeof value === "string" && entry.efforts.includes(value)
    ? value
    : entry.effort;
}

async function prepare(
  client: RequestClient,
  state: Registry,
  method: string,
  params?: JsonObject | null,
): Promise<JsonObject | null | undefined> {
  if (!params) return params;
  const model = requestedModel(params);
  const entry = model === undefined ? undefined : state.models.get(model);
  if (method === "thread/start") {
    if (!entry) return params;
    if (
      params.modelProvider != null &&
      params.modelProvider !== entry.provider
    ) {
      throw new Error(
        `[desktop-providers] Conflicting provider for ${entry.model}`,
      );
    }
    return {
      ...params,
      modelProvider: entry.provider,
      config: {
        ...object(params.config),
        model_reasoning_effort: supportedEffort(
          entry,
          requestedEffort(params) ?? state.selections.get(entry.model),
        ),
      },
    };
  }
  if (
    (method === "turn/start" ||
      method === "thread/resume" ||
      method === "thread/fork") &&
    typeof params.threadId === "string"
  ) {
    const restoring = method !== "turn/start";
    let provider = state.threads.get(params.threadId);
    // An ordinary native turn need not make an extra history request. A known
    // registered-provider chat still needs the guard when switching back to GPT.
    if (!restoring && !entry && provider === undefined) return params;
    if (!provider) {
      const result = await client.sendRequest("thread/read", {
        threadId: params.threadId,
        includeTurns: false,
      });
      observe(state, result);
      provider = state.threads.get(params.threadId);
    }
    if (entry && provider === undefined) {
      throw new Error(
        "[desktop-providers] Could not verify this chat's provider; start a new chat",
      );
    }
    const registeredProviders = new Set(
      [...state.models.values()].map((entry) => entry.provider),
    );
    // Leave the desktop's own unrelated custom runtimes under native control.
    if (
      !entry &&
      (provider === undefined || !registeredProviders.has(provider))
    )
      return params;
    const target =
      model === undefined ? provider : (entry?.provider ?? "openai");
    if (
      provider !== undefined &&
      (target !== provider ||
        (params.modelProvider != null && params.modelProvider !== provider))
    ) {
      throw new Error(
        `[desktop-providers] This chat uses ${provider}. Start a new chat to use ${params.modelProvider ?? target}; changing provider within a chat is not supported`,
      );
    }
    if (restoring) {
      // Some native backends otherwise default forks/resumes to the startup
      // provider. Explicitly retain the verified binding, even without a model.
      if (!entry || requestedEffort(params) == null)
        return { ...params, modelProvider: provider };
      return {
        ...params,
        modelProvider: provider,
        config: {
          ...object(params.config),
          model_reasoning_effort: supportedEffort(
            entry,
            requestedEffort(params),
          ),
        },
      };
    }
    if (entry) {
      // Omitted effort inherits native per-chat state; never reset the last
      // chosen strength merely because a follow-up omitted the field.
      if (requestedEffort(params) == null) return params;
      const effort = supportedEffort(entry, requestedEffort(params));
      const mode = object(params.collaborationMode);
      return {
        ...params,
        ...(mode
          ? {
              collaborationMode: {
                ...mode,
                settings: {
                  ...object(mode.settings),
                  reasoning_effort: effort,
                },
              },
            }
          : {}),
        effort,
      };
    }
  }
  return params;
}

/** Wrap the desktop's existing sender, keeping native scheduling and auth. */
export async function intercept(
  client: RequestClient,
  method: string,
  params: JsonObject | null | undefined,
  options: JsonObject | undefined,
  send: Sender,
): Promise<unknown> {
  if (method === "model/list" && params && catalogRequests.has(params))
    return send(method, params, options);
  // Scope the patch to this machine's local Codex. Cloud/remote transports and
  // the config read used to load profiles must never recurse through discovery.
  if (
    client.hostId !== "local" ||
    ![
      "model/list",
      "thread/start",
      "thread/list",
      "thread/resume",
      "thread/fork",
      "thread/read",
      "turn/start",
    ].includes(method)
  )
    return send(method, params, options);

  if (method === "thread/list") {
    return send(
      method,
      params?.modelProviders == null
        ? { ...params, modelProviders: [] }
        : params,
      options,
    );
  }
  const state = await registry(client);
  const prepared = await prepare(client, state, method, params);
  const result = await send(method, prepared, options);
  observe(state, result);
  if (method === "model/list" && object(result)) {
    return decorateModels(result as JsonObject, state.models);
  }
  return result;
}

/** Prewarming bypasses sendRequest in the desktop; it needs the same routing. */
export async function prewarm(
  client: RequestClient,
  params: JsonObject,
  send: (params: JsonObject) => Promise<unknown>,
): Promise<unknown> {
  if (client.hostId !== "local") return send(params);
  const state = await registry(client);
  const result = await send(
    (await prepare(client, state, "thread/start", params)) as JsonObject,
  );
  observe(state, result);
  return result;
}

/**
 * Keep third-party selection in the desktop's existing in-memory override.
 * Persisting its raw model ID as the global OpenAI default would affect CLI,
 * background tasks and the next unpatched launch.
 */
export async function writeDefault(
  client: RequestClient,
  model: string,
  effort: unknown,
  original: () => Promise<unknown>,
): Promise<unknown> {
  if (client.hostId === "local") {
    const state = await registry(client);
    const entry = state.models.get(model);
    if (entry) {
      state.selections.set(model, supportedEffort(entry, effort));
      return { status: "okOverridden" };
    }
  }
  return original();
}
