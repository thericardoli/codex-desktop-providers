import assert from "node:assert/strict";
import test from "node:test";
import { intercept, prewarm, writeDefault } from "../src/runtime/index.js";
import {
  appendModels,
  isRegisteredModel,
  readProfiles,
  restorePickerEfforts,
} from "../src/runtime/registry.js";
import {
  object,
  type JsonObject,
  type RequestClient,
} from "../src/runtime/types.js";

const MODEL = "z-ai/glm-5.3-flash";
const config = () => ({
  model: "native-gpt",
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
      model_reasoning_effort: "high",
      model_reasoning_efforts: ["low", "high", "max"],
      model_context_window: 1048576,
      approval_policy: "never",
      developer_instructions: "must not be copied",
    },
  },
});

function fixture(hostId = "local", layers?: unknown) {
  const calls: {
    method: string;
    params: JsonObject | null | undefined;
    options: JsonObject | undefined;
  }[] = [];
  const threads = new Map<string, string>();
  const nativeModel = {
    id: "native-gpt",
    model: "native-gpt",
    hidden: false,
    isDefault: true,
    availableAccessPrograms: { cyber: ["special"] },
  };
  const client: RequestClient = {
    hostId,
    sendRequest(method, params, options) {
      return intercept(
        client,
        method,
        params,
        options,
        async (method, params, options) => {
          calls.push({ method, params, options });
          if (method === "config/read") return { config: config(), layers };
          if (method === "model/list")
            return { data: [nativeModel], nextCursor: null };
          if (method === "thread/start") {
            const id = `thread-${threads.size}`;
            const provider = String(params?.modelProvider ?? "openai");
            threads.set(id, provider);
            return {
              thread: { id, modelProvider: provider },
              model: params?.model,
            };
          }
          if (
            method === "thread/read" ||
            method === "thread/resume" ||
            method === "thread/fork"
          )
            return {
              thread: {
                id: params?.threadId,
                modelProvider: threads.get(String(params?.threadId)),
              },
            };
          return { ok: true };
        },
      );
    },
  };
  return { client, calls, threads, nativeModel };
}

test("register native profiles without copying provider auth or security settings", () => {
  const entries = readProfiles(config());
  const entry = entries.get(MODEL)!;
  assert.equal(entry.provider, "openrouter");
  assert.deepEqual(entry.config, {
    model_context_window: 1048576,
    model_reasoning_effort: "high",
  });
  assert.equal(
    JSON.stringify([...entries]).includes("DO_NOT_SERIALIZE"),
    false,
  );
  assert.equal(
    JSON.stringify([...entries]).includes("developer_instructions"),
    false,
  );
});

test("use a configured display name without changing inference IDs or tuning", async () => {
  const layers = [
    {
      name: { type: "user" },
      config: { profiles: { glm: { model_name: " GLM 5.3 Flash " } } },
    },
  ];
  const { client, calls, nativeModel } = fixture("local", layers);
  const result = object(await client.sendRequest("model/list", {}))!;
  const models = result.data as JsonObject[];
  assert.equal(models[0], nativeModel);
  assert.equal(models[1]?.displayName, "GLM 5.3 Flash (OpenRouter)");
  assert.equal(models[1]?.description, "GLM 5.3 Flash via OpenRouter");
  assert.equal(models[1]?.id, MODEL);
  assert.equal(models[1]?.model, MODEL);
  assert.equal(
    calls.find((call) => call.method === "config/read")?.params?.includeLayers,
    true,
  );
  await client.sendRequest("thread/start", { model: MODEL });
  const request = calls.at(-1)?.params!;
  assert.equal(request.model, MODEL);
  assert.equal(request.modelProvider, "openrouter");
  assert.equal(Object.hasOwn(object(request.config)!, "model_name"), false);
});

test("read display metadata from enabled config layers in native priority order", () => {
  const layer = (type: string, label: string, disabledReason?: string) => ({
    name: { type },
    config: {
      profiles: {
        glm: {
          model_name: label,
          model: "must-not-override-native-id",
          model_provider: "must-not-override-native-provider",
        },
      },
    },
    disabledReason,
  });
  const layers = [
    layer("project", "Untrusted project name"),
    layer("user", "Disabled name", "disabled"),
    layer("sessionFlags", "CLI 模型名称"),
    layer("user", "User name"),
    layer("system", "System name"),
  ];
  const entry = readProfiles(config(), layers).get(MODEL)!;
  assert.equal(entry.modelName, "CLI 模型名称");
  assert.equal(entry.model, MODEL);
  assert.equal(entry.provider, "openrouter");
  assert.equal(
    readProfiles(config(), [layer("project", "Ignored")]).get(MODEL)?.modelName,
    undefined,
  );
});

test("reject multiple profiles for the same model instead of merging legacy variants", () => {
  const base = config();
  assert.throws(
    () =>
      readProfiles({
        ...base,
        profiles: {
          ...base.profiles,
          duplicate: { ...base.profiles.glm, model_reasoning_effort: "low" },
        },
      }),
    /one profile per model/,
  );
});

test("reject invalid model names and keep model-id fallback for unnamed entries", () => {
  for (const model_name of ["", "   ", 123, {}, []]) {
    assert.throws(
      () =>
        readProfiles({
          ...config(),
          profiles: { glm: { ...config().profiles.glm, model_name } },
        }),
      /non-empty string/,
    );
  }
  const result = appendModels({ data: [] }, readProfiles(config()));
  assert.equal(
    (result.data as JsonObject[])[0]?.displayName,
    `${MODEL} (OpenRouter)`,
  );
});

test("ignore official and non-model profiles", () => {
  assert.equal(
    readProfiles({
      profiles: {
        official: { model: "gpt", model_provider: "openai" },
        security: { approval_policy: "never" },
      },
    }).size,
    0,
  );
});

test("reject undefined, incompatible, ambiguous and invalid-effort registrations", () => {
  assert.throws(
    () => readProfiles({ profiles: config().profiles }),
    /undefined provider/,
  );
  assert.throws(
    () =>
      readProfiles({
        ...config(),
        model_providers: { openrouter: { wire_api: "chat" } },
      }),
    /does not translate/,
  );
  assert.throws(
    () =>
      readProfiles({
        ...config(),
        model_providers: {
          ...config().model_providers,
          other: { wire_api: "responses" },
        },
        profiles: {
          ...config().profiles,
          duplicate: { ...config().profiles.glm, model_provider: "other" },
        },
      }),
    /one profile per model/,
  );
  assert.throws(
    () =>
      readProfiles({
        ...config(),
        profiles: {
          glm: { ...config().profiles.glm, model_reasoning_effort: "invented" },
        },
      }),
    /must be included/,
  );
});

test("append model metadata without changing native entries or entitlement flags", async () => {
  const { client, nativeModel } = fixture();
  const response = object(await client.sendRequest("model/list", {}))!;
  const data = response.data as JsonObject[];
  assert.equal(data[0], nativeModel);
  assert.equal(data.length, 2);
  assert.equal(data[1]?.model, MODEL);
  assert.equal(data[1]?.displayName, `${MODEL} (OpenRouter)`);
  assert.equal(isRegisteredModel(data[1]), true);
  assert.equal(isRegisteredModel(nativeModel), false);
});

test("respect native pagination and reject collisions with the native catalog", () => {
  const entries = readProfiles(config());
  const first = { data: [], nextCursor: "page2" };
  assert.equal(appendModels(first, entries), first);
  assert.throws(
    () => appendModels({ data: [{ model: MODEL }], nextCursor: null }, entries),
    /ambiguous provider/,
  );
  assert.throws(
    () =>
      appendModels({ data: [{ model: MODEL }], nextCursor: "page2" }, entries),
    /ambiguous provider/,
  );
});

test("route new custom chats directly with only whitelisted model tuning", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/start", {
    model: MODEL,
    modelProvider: null,
    config: { "features.example": false },
    cwd: "/project",
  });
  const sent = calls.find((call) => call.method === "thread/start")!.params!;
  assert.equal(sent.model, MODEL);
  assert.equal(sent.modelProvider, "openrouter");
  assert.equal(sent.cwd, "/project");
  assert.deepEqual(sent.config, {
    model_context_window: 1048576,
    model_reasoning_effort: "high",
    "features.example": false,
  });
});

test("leave official starts and explicit unrelated runtimes untouched", async () => {
  const { client, calls } = fixture();
  const original = { model: "native-gpt", modelProvider: null };
  await client.sendRequest("thread/start", original);
  assert.equal(calls.at(-1)?.params, original);
  await assert.rejects(
    client.sendRequest("thread/start", {
      model: MODEL,
      modelProvider: "another",
    }),
    /Conflicting provider/,
  );
});

test("apply routing to the native prewarm path", async () => {
  const { client } = fixture();
  let sent: JsonObject | undefined;
  await prewarm(client, { model: MODEL }, async (params) => {
    sent = params;
    return { thread: { id: "prewarmed", modelProvider: "openrouter" } };
  });
  assert.equal(sent?.modelProvider, "openrouter");
});

test("pin provider for follow-up turns and reject switching in either direction", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/start", { model: MODEL });
  await client.sendRequest("turn/start", {
    threadId: "thread-0",
    collaborationMode: {
      mode: "default",
      settings: { model: MODEL, reasoning_effort: "ultra" },
    },
  });
  const sent = calls.at(-1)?.params!;
  assert.equal(
    object(object(sent.collaborationMode)?.settings)?.reasoning_effort,
    "high",
  );
  await assert.rejects(
    client.sendRequest("turn/start", {
      threadId: "thread-0",
      model: "native-gpt",
    }),
    /Start a new chat/,
  );
  await client.sendRequest("thread/start", { model: "native-gpt" });
  await assert.rejects(
    client.sendRequest("turn/start", { threadId: "thread-1", model: MODEL }),
    /Start a new chat/,
  );
});

test("verify persisted provider before resuming a custom model", async () => {
  const { client, threads, calls } = fixture();
  threads.set("old", "openrouter");
  await client.sendRequest("thread/resume", { threadId: "old", model: MODEL });
  assert.deepEqual(calls.at(-1)?.params?.config, {
    model_context_window: 1048576,
  });
  assert.equal(calls.at(-1)?.params?.effort, undefined);
  threads.set("official", "openai");
  await assert.rejects(
    client.sendRequest("thread/resume", { threadId: "official", model: MODEL }),
    /Start a new chat/,
  );
  await assert.rejects(
    client.sendRequest("thread/resume", { threadId: "missing", model: MODEL }),
    /Could not verify/,
  );
});

test("do not perform extra thread reads for ordinary native turns", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("turn/start", {
    threadId: "unknown-native",
    model: "native-gpt",
  });
  assert.equal(
    calls.some((call) => call.method === "thread/read"),
    false,
  );
});

test("unify only unspecified thread list filters", async () => {
  const { client, calls } = fixture();
  await client.sendRequest("thread/list", { modelProviders: null });
  assert.deepEqual(calls.at(-1)?.params?.modelProviders, []);
  const explicit = { modelProviders: ["openai"] };
  await client.sendRequest("thread/list", explicit);
  assert.equal(calls.at(-1)?.params, explicit);
});

test("custom default selection does not write global model/provider or credentials", async () => {
  const { client } = fixture();
  let writes = 0;
  const write = async () => {
    writes++;
    return { status: "ok" };
  };
  assert.deepEqual(await writeDefault(client, MODEL, "high", write), {
    status: "okOverridden",
  });
  assert.equal(writes, 0);
  await writeDefault(client, "native-gpt", "high", write);
  assert.equal(writes, 1);
});

test("read one explicit effort list with canonical order and a declared default", () => {
  const entry = readProfiles(config()).get(MODEL)!;
  assert.equal(entry.effort, "high");
  assert.deepEqual(entry.efforts, ["low", "high", "max"]);
  const base = config();
  const firstDefault = readProfiles({
    ...base,
    profiles: {
      glm: {
        ...base.profiles.glm,
        model_reasoning_effort: null,
        model_reasoning_efforts: ["max", "low", "high"],
      },
    },
  }).get(MODEL)!;
  assert.equal(firstDefault.effort, "max");
  assert.deepEqual(firstDefault.efforts, ["low", "high", "max"]);
});

test("require valid nonempty lists and reject legacy scalar-only registrations", () => {
  const base = config();
  for (const model_reasoning_efforts of [
    undefined,
    null,
    [],
    "high",
    ["high", 123],
    ["invented"],
    ["high", "high"],
  ]) {
    assert.throws(
      () =>
        readProfiles({
          ...base,
          profiles: { glm: { ...base.profiles.glm, model_reasoning_efforts } },
        }),
      /model_reasoning_efforts/,
    );
  }
  assert.throws(
    () =>
      readProfiles({
        ...base,
        profiles: {
          glm: { ...base.profiles.glm, model_reasoning_effort: "medium" },
        },
      }),
    /must be included/,
  );
});

test("read list metadata from enabled native layers without copying it into inference config", () => {
  const base = config();
  const { model_reasoning_efforts: removed, ...profile } = base.profiles.glm;
  void removed;
  const effective = { ...base, profiles: { glm: profile } };
  const layer = (type: string, efforts: unknown, disabledReason?: string) => ({
    name: { type },
    disabledReason,
    config: { profiles: { glm: { model_reasoning_efforts: efforts } } },
  });
  const entry = readProfiles(effective, [
    layer("project", ["ultra"]),
    layer("user", ["none"], "disabled"),
    layer("sessionFlags", ["low", "high", "max"]),
    layer("user", ["high"]),
  ]).get(MODEL)!;
  assert.deepEqual(entry.efforts, ["low", "high", "max"]);
  assert.equal(Object.hasOwn(entry.config, "model_reasoning_efforts"), false);
  assert.throws(
    () => readProfiles(effective, [layer("project", ["high"])]),
    /non-empty list/,
  );
});

test("keep declared effort options despite native account filtering without changing native models", () => {
  const catalog = appendModels({ data: [] }, readProfiles(config()))
    .data as JsonObject[];
  const native = {
    model: "native-gpt",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  };
  const custom = { ...catalog[0], supportedReasoningEfforts: [] };
  const result = restorePickerEfforts(
    { models: [native, custom], defaultModel: custom },
    catalog,
  );
  assert.equal((result.models as JsonObject[])[0], native);
  assert.deepEqual(
    (result.models as JsonObject[])[1]?.supportedReasoningEfforts,
    catalog[0]?.supportedReasoningEfforts,
  );
  assert.equal(result.defaultModel, (result.models as JsonObject[])[1]);
});

test("honor selected effort in new chats, collaboration modes, and ordinary turns", async () => {
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
    effort: "low",
  });
  assert.equal(calls.at(-1)?.params?.effort, "low");
  const followup = { threadId: "thread-0", model: MODEL };
  await client.sendRequest("turn/start", followup);
  assert.equal(calls.at(-1)?.params, followup);
});

test("remember effort for subsequent new chats and prewarming without global writes", async () => {
  const { client, calls } = fixture();
  await writeDefault(client, MODEL, "low", async () => {
    throw Error("must not persist");
  });
  await client.sendRequest("thread/start", { model: MODEL });
  assert.equal(
    object(calls.at(-1)?.params?.config)?.model_reasoning_effort,
    "low",
  );
  await prewarm(client, { model: MODEL }, async (params) => {
    assert.equal(object(params.config)?.model_reasoning_effort, "low");
    return {};
  });
  await client.sendRequest("thread/resume", {
    threadId: "thread-0",
    model: MODEL,
  });
  assert.equal(
    object(calls.at(-1)?.params?.config)?.model_reasoning_effort,
    undefined,
  );
});

test("leave remote and cloud requests outside the patch", async () => {
  const { client, calls } = fixture("remote-host");
  await client.sendRequest("thread/start", { model: MODEL });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["thread/start"],
  );
  assert.equal(calls[0]?.params?.modelProvider, undefined);
});
