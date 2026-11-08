import assert from "node:assert/strict";
import test from "node:test";
import { intercept, prewarm, writeDefault } from "../src/runtime/index.js";
import {
  decorateModels,
  isRegisteredModel,
  readProfiles,
  restorePickerEfforts,
} from "../src/runtime/registry.js";
import {
  object,
  type JsonObject,
  type RequestClient,
  type Sender,
} from "../src/runtime/types.js";

const MODEL = "z-ai/glm-5.3-flash";
const config = (): JsonObject => ({
  model: "native-gpt",
  model_catalog_json: "/synthetic/models.json",
  model_providers: {
    openrouter: {
      name: "OpenRouter",
      wire_api: "responses",
      auth: { command: "DO_NOT_SERIALIZE_THIS_CREDENTIAL_HELPER" },
    },
  },
  profiles: {
    glm: {
      model: MODEL,
      model_provider: "openrouter",
      approval_policy: "never",
      developer_instructions: "must not be copied",
    },
  },
});
const nativeModel = () => ({
  id: "native-gpt",
  model: "native-gpt",
  hidden: false,
  isDefault: true,
  availableAccessPrograms: { cyber: ["special"] },
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "high" },
  ],
});
const customModel = (): JsonObject => ({
  id: MODEL,
  model: MODEL,
  displayName: "GLM 5.3 Flash",
  description: "Native catalog description",
  hidden: false,
  isDefault: false,
  inputModalities: ["text", "image"],
  supportedReasoningEfforts: ["low", "high", "max"].map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort,
  })),
  defaultReasoningEffort: "high",
  supportsPersonality: false,
});
function profileConfig(profile: JsonObject): JsonObject {
  return { ...config(), profiles: { glm: profile } };
}
const route = () => ({ model: MODEL, model_provider: "openrouter" });

function fixture(
  options: {
    hostId?: string;
    config?: JsonObject;
    layers?: unknown;
    catalog?: JsonObject[];
    list?: (params?: JsonObject | null) => JsonObject;
  } = {},
) {
  const calls: {
    method: string;
    params: JsonObject | null | undefined;
    options: JsonObject | undefined;
  }[] = [];
  const threads = new Map<string, string>();
  const native = nativeModel();
  const custom = customModel();
  const raw: Sender = async (method, params, requestOptions) => {
    calls.push({ method, params, options: requestOptions });
    if (method === "config/read")
      return { config: options.config ?? config(), layers: options.layers };
    if (method === "model/list")
      return (
        options.list?.(params) ?? {
          data: options.catalog ?? [native, custom],
          nextCursor: null,
        }
      );
    if (method === "thread/start") {
      const id = `thread-${threads.size}`;
      const provider = String(params?.modelProvider ?? "openai");
      threads.set(id, provider);
      return { thread: { id, modelProvider: provider }, model: params?.model };
    }
    if (["thread/read", "thread/resume", "thread/fork"].includes(method))
      return {
        thread: {
          id: params?.threadId,
          modelProvider: threads.get(String(params?.threadId)),
        },
      };
    return { ok: true };
  };
  const client: RequestClient = {
    hostId: options.hostId ?? "local",
    sendRequest: (method, params, opts) =>
      intercept(client, method, params, opts, raw),
  };
  return { client, calls, threads, native, custom };
}

test("use native catalog metadata and profiles only for provider routing", () => {
  const entry = readProfiles(config(), [customModel()]).get(MODEL)!;
  assert.equal(entry.provider, "openrouter");
  assert.equal(entry.effort, "high");
  assert.deepEqual(entry.efforts, ["low", "high", "max"]);
  assert.equal(Object.hasOwn(entry, "config"), false);
  assert.doesNotMatch(
    JSON.stringify([...readProfiles(config(), [customModel()])]),
    /DO_NOT_SERIALIZE|developer_instructions|approval_policy/,
  );
});

test("require the startup catalog and reject per-thread catalog selection", () => {
  for (const model_catalog_json of [undefined, null, "", " ", 42])
    assert.throws(
      () => readProfiles({ ...config(), model_catalog_json }, [customModel()]),
      /Configure model_catalog_json at startup/,
    );
  assert.throws(
    () =>
      readProfiles(
        profileConfig({ ...route(), model_catalog_json: "/other.json" }),
        [customModel()],
      ),
    /per-thread catalogs/,
  );
  assert.equal(
    readProfiles(
      profileConfig({
        ...route(),
        model_catalog_json: "/synthetic/models.json",
      }),
      [customModel()],
    ).size,
    1,
  );
});

test("reject legacy profile model metadata even when native normalization dropped it", () => {
  for (const [key, value] of Object.entries({
    model_name: "GLM",
    model_reasoning_efforts: ["high"],
    model_reasoning_effort: "high",
    model_context_window: 1048576,
    model_auto_compact_token_limit: 900000,
    model_reasoning_summary: "none",
    model_verbosity: "low",
  })) {
    assert.throws(
      () =>
        readProfiles(profileConfig({ ...route(), [key]: value }), [
          customModel(),
        ]),
      /Move .* into model_catalog_json/,
    );
    assert.throws(
      () =>
        readProfiles(
          config(),
          [customModel()],
          [
            {
              name: { type: "user" },
              config: { profiles: { glm: { [key]: value } } },
            },
          ],
        ),
      /Move .* into model_catalog_json/,
    );
  }
});

test("ignore disabled and project layers for legacy migration diagnostics", () => {
  const layer = { config: { profiles: { glm: { model_context_window: 1 } } } };
  assert.equal(
    readProfiles(
      config(),
      [customModel()],
      [
        { ...layer, name: { type: "project" } },
        { ...layer, name: { type: "user" }, disabledReason: "untrusted" },
      ],
    ).size,
    1,
  );
});

test("require an exact, unambiguous loaded model and reject invalid provider routes", () => {
  assert.throws(() => readProfiles(config(), []), /found 0/);
  assert.throws(
    () => readProfiles(config(), [customModel(), customModel()]),
    /found 2/,
  );
  for (const model of ["", " ", ` ${MODEL}`])
    assert.throws(
      () => readProfiles(profileConfig({ ...route(), model }), [customModel()]),
      /exact non-empty/,
    );
  assert.throws(
    () =>
      readProfiles(
        { ...config(), profiles: { first: route(), second: route() } },
        [customModel()],
      ),
    /multiple profiles/,
  );
  assert.throws(
    () => readProfiles({ ...config(), model_providers: {} }, [customModel()]),
    /undefined provider/,
  );
  assert.throws(
    () =>
      readProfiles(
        { ...config(), model_providers: { openrouter: { wire_api: "chat" } } },
        [customModel()],
      ),
    /does not translate/,
  );
});

test("leave native and non-model profiles unregistered", () => {
  assert.equal(
    readProfiles(
      {
        profiles: {
          official: { model: "gpt", model_provider: "openai" },
          security: { approval_policy: "never" },
        },
      },
      [],
    ).size,
    0,
  );
});

test("preserve global OpenAI routing and the official default model", () => {
  assert.throws(
    () =>
      readProfiles({ ...config(), model_provider: "openrouter" }, [
        customModel(),
      ]),
    /global model_provider/,
  );
  assert.throws(
    () => readProfiles({ ...config(), model: MODEL }, [customModel()]),
    /official model as the global default/,
  );
});

test("do not fetch a catalog when no external profiles are registered", async () => {
  const { client, calls } = fixture({ config: { model: "native-gpt" } });
  const params = { model: "native-gpt" };
  await client.sendRequest("thread/start", params);
  assert.equal(calls.at(-1)?.params, params);
  assert.equal(
    calls.some((call) => call.method === "model/list"),
    false,
  );
});

test("validate native effort declarations without inventing options or defaults", () => {
  for (const supportedReasoningEfforts of [
    undefined,
    [],
    [{}],
    [{ reasoningEffort: "invented" }],
    [{ reasoningEffort: "high" }, { reasoningEffort: "high" }],
  ])
    assert.throws(
      () =>
        readProfiles(config(), [
          { ...customModel(), supportedReasoningEfforts },
        ]),
      /supported reasoning efforts/,
    );
  for (const defaultReasoningEffort of [null, undefined, "medium"])
    assert.throws(
      () =>
        readProfiles(config(), [{ ...customModel(), defaultReasoningEffort }]),
      /default included/,
    );
  for (const displayName of [null, "", " ", 123])
    assert.throws(
      () => readProfiles(config(), [{ ...customModel(), displayName }]),
      /display name/,
    );
});

test("decorate native catalog entries without duplicates or changing official metadata", async () => {
  const { client, native, custom } = fixture();
  const response = object(await client.sendRequest("model/list", {}))!;
  const data = response.data as JsonObject[];
  assert.equal(data.length, 2);
  assert.equal(data[0], native);
  assert.equal(isRegisteredModel(data[0]), false);
  assert.equal(isRegisteredModel(data[1]), true);
  assert.deepEqual(data[1], {
    ...custom,
    displayName: "GLM 5.3 Flash (OpenRouter)",
    codexDesktopProvider: "openrouter",
  });
});

test("preserve native pagination and discover registered entries on later pages", async () => {
  const native = nativeModel();
  const custom = customModel();
  const { client, calls } = fixture({
    list: (params) =>
      params?.cursor === "second"
        ? { data: [custom], nextCursor: null }
        : { data: [native], nextCursor: "second" },
  });
  const first = object(await client.sendRequest("model/list", { limit: 1 }))!;
  assert.equal(first.nextCursor, "second");
  assert.deepEqual(first.data, [native]);
  const second = object(
    await client.sendRequest("model/list", { cursor: "second", limit: 1 }),
  )!;
  assert.equal(
    (second.data as JsonObject[])[0]?.displayName,
    "GLM 5.3 Flash (OpenRouter)",
  );
  assert.equal(calls.filter((c) => c.method === "config/read").length, 1);
  assert.equal(calls.filter((c) => c.method === "model/list").length, 4);
});

test("reject missing or cyclic native catalog responses before routing", async () => {
  for (const list of [
    () => ({}),
    () => ({ data: [], nextCursor: "again" }),
    () => ({ data: [], nextCursor: 42 }),
  ]) {
    const { client, calls } = fixture({ list });
    await assert.rejects(
      client.sendRequest("thread/start", { model: MODEL }),
      /catalog/,
    );
    assert.equal(
      calls.some((c) => c.method === "thread/start"),
      false,
    );
  }
});

test("concurrent ordinary requests retain routing guards during catalog loading", async () => {
  const { client, calls } = fixture();
  const [a, b] = await Promise.allSettled([
    client.sendRequest("thread/start", { model: MODEL }),
    client.sendRequest("thread/start", {
      model: MODEL,
      modelProvider: "wrong",
    }),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(calls.filter((c) => c.method === "config/read").length, 1);
  assert.equal(calls.filter((c) => c.method === "thread/start").length, 1);
});

test("route new chats with catalog effort while leaving native context metadata to the backend", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/start", {
    model: MODEL,
    modelProvider: null,
    config: { "features.example": false },
    cwd: "/project",
  });
  assert.deepEqual(calls.at(-1)?.params, {
    model: MODEL,
    modelProvider: "openrouter",
    config: { "features.example": false, model_reasoning_effort: "high" },
    cwd: "/project",
  });
});

test("leave official starts untouched and reject conflicting custom providers", async () => {
  const { client, calls } = fixture();
  const original = { model: "native-gpt", modelProvider: null };
  await client.sendRequest("thread/start", original);
  assert.equal(calls.at(-1)?.params, original);
  await assert.rejects(
    client.sendRequest("thread/start", {
      model: MODEL,
      modelProvider: "other",
    }),
    /Conflicting provider/,
  );
});

test("load native catalog for prewarming even before any model-list request", async () => {
  const { client } = fixture();
  let sent: JsonObject | undefined;
  await prewarm(client, { model: MODEL }, async (params) => {
    sent = params;
    return { thread: { id: "warm", modelProvider: "openrouter" } };
  });
  assert.equal(sent?.modelProvider, "openrouter");
  assert.deepEqual(sent?.config, { model_reasoning_effort: "high" });
});

test("pin providers for turns, resume and forks; never rewrite existing chats", async () => {
  const { client, threads } = fixture();
  threads.set("custom", "openrouter");
  threads.set("official", "openai");
  for (const method of ["turn/start", "thread/resume", "thread/fork"]) {
    await assert.rejects(
      client.sendRequest(method, { threadId: "official", model: MODEL }),
      /Start a new chat/,
    );
    await client.sendRequest(method, { threadId: "custom", model: MODEL });
    await assert.rejects(
      client.sendRequest(method, { threadId: "custom", model: "native-gpt" }),
      /Start a new chat/,
    );
    await assert.rejects(
      client.sendRequest(method, { threadId: "missing", model: MODEL }),
      /Could not verify/,
    );
  }
});

test("resume and fork preserve native tuning and explicit selected effort", async () => {
  const { client, calls, threads } = fixture();
  threads.set("old", "openrouter");
  for (const method of ["thread/resume", "thread/fork"]) {
    const params = { threadId: "old", model: MODEL };
    await client.sendRequest(method, params);
    assert.deepEqual(calls.at(-1)?.params, {
      ...params,
      modelProvider: "openrouter",
    });
    await client.sendRequest(method, {
      ...params,
      config: { model_reasoning_effort: "low", "features.example": false },
    });
    assert.deepEqual(calls.at(-1)?.params?.config, {
      model_reasoning_effort: "low",
      "features.example": false,
    });
  }
});

test("preserve persisted provider on model-less resume/fork and reject provider-only switches", async () => {
  const { client, calls, threads } = fixture();
  threads.set("old", "openrouter");
  for (const method of ["thread/resume", "thread/fork"]) {
    await client.sendRequest(method, { threadId: "old" });
    assert.deepEqual(calls.at(-1)?.params, {
      threadId: "old",
      modelProvider: "openrouter",
    });
    await assert.rejects(
      client.sendRequest(method, { threadId: "old", modelProvider: "openai" }),
      /Start a new chat/,
    );
  }
});

test("do not read native history for ordinary native turns", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("turn/start", {
    threadId: "native",
    model: "native-gpt",
  });
  assert.equal(
    calls.some((c) => c.method === "thread/read"),
    false,
  );
});

test("unify only unspecified history filters without loading catalog", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/list", { modelProviders: null });
  assert.deepEqual(calls.at(-1)?.params?.modelProviders, []);
  const explicit = { modelProviders: ["openai"] };
  await client.sendRequest("thread/list", explicit);
  assert.equal(calls.at(-1)?.params, explicit);
  assert.equal(
    calls.some((c) => c.method === "config/read"),
    false,
  );
});

test("keep custom defaults in memory and remember selected effort for new chats", async () => {
  const { client, calls } = fixture();
  let writes = 0;
  const write = async () => {
    writes++;
    return {};
  };
  assert.deepEqual(await writeDefault(client, MODEL, "low", write), {
    status: "okOverridden",
  });
  assert.equal(writes, 0);
  await client.sendRequest("thread/start", { model: MODEL });
  assert.equal(
    object(calls.at(-1)?.params?.config)?.model_reasoning_effort,
    "low",
  );
  await prewarm(client, { model: MODEL }, async (params) => {
    assert.equal(object(params.config)?.model_reasoning_effort, "low");
    return {};
  });
  await writeDefault(client, "native-gpt", "high", write);
  assert.equal(writes, 1);
});

test("honor scalar and collaboration-mode effort, preserving omitted follow-up effort", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/start", {
    model: MODEL,
    config: { model_reasoning_effort: "low" },
  });
  assert.equal(
    object(calls.at(-1)?.params?.config)?.model_reasoning_effort,
    "low",
  );
  await client.sendRequest("turn/start", {
    threadId: "thread-0",
    collaborationMode: {
      mode: "default",
      settings: { model: MODEL, reasoning_effort: "max" },
    },
    effort: "high",
  });
  assert.equal(
    object(object(calls.at(-1)?.params?.collaborationMode)?.settings)
      ?.reasoning_effort,
    "max",
  );
  assert.equal(calls.at(-1)?.params?.effort, "max");
  await client.sendRequest("turn/start", {
    threadId: "thread-0",
    model: MODEL,
    effort: "ultra",
  });
  assert.equal(calls.at(-1)?.params?.effort, "high");
  const followup = { threadId: "thread-0", model: MODEL };
  await client.sendRequest("turn/start", followup);
  assert.equal(calls.at(-1)?.params, followup);
});

test("preserve catalog hidden flags and native effort filtering", () => {
  const native = nativeModel();
  const custom: JsonObject = { ...customModel(), hidden: true };
  const entries = readProfiles(config(), [native, custom]);
  const catalog = decorateModels({ data: [native, custom] }, entries)
    .data as JsonObject[];
  assert.equal(catalog[1]?.hidden, true);
  const filteredNative = {
    ...native,
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  };
  const result = restorePickerEfforts(
    {
      models: [
        filteredNative,
        { ...catalog[1], supportedReasoningEfforts: [] },
      ],
      defaultModel: filteredNative,
    },
    catalog,
  );
  assert.equal((result.models as JsonObject[])[0], filteredNative);
  assert.deepEqual(
    (result.models as JsonObject[])[1]?.supportedReasoningEfforts,
    custom.supportedReasoningEfforts,
  );
  assert.equal(result.defaultModel, filteredNative);
});

test("leave remote and cloud transports untouched", async () => {
  const { client, calls } = fixture({ hostId: "remote" });
  await client.sendRequest("thread/start", { model: MODEL });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/start"],
  );
  assert.equal(calls[0]?.params?.modelProvider, undefined);
});
