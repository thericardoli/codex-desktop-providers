import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../src/runtime/index.js";
import {
  isRegisteredModel,
  restorePickerEfforts,
} from "../src/runtime/registry.js";
import { transformPicker, transformShared } from "../src/patch/transforms.js";
import type { JsonObject } from "../src/runtime/types.js";

import {
  shared,
  sharedWithExtension,
  extensionMethod,
  picker,
  nestedPicker,
} from "./fixtures.js";

function extensionFixture(hostId = "local", source = sharedWithExtension) {
  const patched = transformShared(source);
  const Client = Function(
    "__codexDesktopProviders",
    `${patched.slice(patched.indexOf("export class Client")).replaceAll("export ", "")}\nreturn Client;`,
  )(runtime);
  const calls: { method: string; params: JsonObject; options: unknown }[] = [];
  const client = new Client();
  client.hostId = hostId;
  client.dispatchMessage = () => {};
  client.enqueueRequest = async (
    method: string,
    params: JsonObject,
    options: unknown,
  ) => {
    calls.push({ method, params, options });
    if (method === "config/read")
      return {
        config: {
          model_catalog_json: "/synthetic/models.json",
          model_providers: { external: { wire_api: "responses" } },
          profiles: {
            custom: { model: "external", model_provider: "external" },
          },
        },
      };
    if (method === "model/list")
      return {
        data: [
          {
            model: "external",
            displayName: "External model",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/start")
      return {
        thread: { id: "new", modelProvider: params.modelProvider ?? "openai" },
      };
    if (method === "thread/read")
      return { thread: { id: params.threadId, modelProvider: "openai" } };
    return {};
  };
  return { client, calls };
}

test("route extension-created chats before the first turn and retain native extension flags", async () => {
  const { client, calls } = extensionFixture();
  const options = { priority: "critical", trace: {} };
  const request = { model: "external", config: { "features.example": false } };
  const envelope = { request, daybreakProgramPropagationEnrolled: false };
  const result = await client.sendAppServerExtensionRequest(
    "thread/start",
    envelope,
    options,
  );
  assert.equal(result.thread.modelProvider, "external");
  assert.deepEqual(calls.at(-1), {
    method: "thread/start",
    params: {
      model: "external",
      modelProvider: "external",
      config: { "features.example": false, model_reasoning_effort: "high" },
      daybreakProgramPropagationEnrolled: false,
    },
    options,
  });
  assert.equal(calls.at(-1)?.options, options);
  assert.deepEqual(request, {
    model: "external",
    config: { "features.example": false },
  });
  await client.sendRequest("turn/start", {
    threadId: "new",
    model: "external",
  });
  assert.equal(
    calls.some((call) => call.method === "thread/read"),
    false,
  );
  assert.equal(
    calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  await assert.rejects(
    client.sendRequest("turn/start", { threadId: "new", model: "official" }),
    /Start a new chat/,
  );
});

test("extension routing runs after native envelope flattening and preserves provider guards", async () => {
  const { client, calls } = extensionFixture();
  // The native extension merges outer fields last. Validate the effective
  // provider rather than allowing an outer field to undo a routed request.
  await assert.rejects(
    client.sendAppServerExtensionRequest("thread/start", {
      request: { model: "external" },
      modelProvider: "openai",
    }),
    /Conflicting provider/,
  );
  await assert.rejects(
    client.sendAppServerExtensionRequest("thread/resume", {
      request: { threadId: "existing", model: "external" },
    }),
    /Start a new chat/,
  );
  assert.equal(
    calls.some((call) => call.method === "thread/start"),
    false,
  );
  assert.equal(
    calls.some((call) => call.method === "thread/resume"),
    false,
  );
});

test("extension dispatch retains official requests, remote hosts and native admission errors", async () => {
  const { client, calls } = extensionFixture();
  const envelope = {
    request: { model: "official", modelProvider: null },
    daybreakProgramPropagationEnrolled: true,
  };
  await client.sendAppServerExtensionRequest("thread/start", envelope);
  assert.deepEqual(calls.at(-1)?.params, {
    ...envelope.request,
    daybreakProgramPropagationEnrolled: true,
  });
  const before = calls.length;
  await assert.rejects(
    client.sendAppServerExtensionRequest("turn/addUserMessage", {}),
    /requires a cloud host/,
  );
  assert.equal(calls.length, before);
  const remote = extensionFixture("remote");
  await remote.client.sendAppServerExtensionRequest("thread/start", {
    request: { model: "external" },
    daybreakProgramPropagationEnrolled: false,
  });
  assert.deepEqual(remote.calls, [
    {
      method: "thread/start",
      params: { model: "external", daybreakProgramPropagationEnrolled: false },
      options: undefined,
    },
  ]);
});

test("route dedicated extension thread-start branches as well as generic envelopes", async () => {
  const dedicated = extensionMethod.replace(
    'if (method === "turn/addUserMessage")',
    'if (method !== "thread/start")',
  );
  for (const source of [
    sharedWithExtension.replace(extensionMethod, dedicated),
    sharedWithExtension
      .replace(
        "async sendAppServerExtensionRequest(",
        'async ["sendAppServerExtensionRequest"](',
      )
      .replaceAll("this.enqueueRequest(", 'this["enqueueRequest"]('),
  ]) {
    const { client, calls } = extensionFixture("local", source);
    const result = await client.sendAppServerExtensionRequest("thread/start", {
      request: { model: "external" },
      daybreakProgramPropagationEnrolled: false,
    });
    assert.equal(result.thread.modelProvider, "external");
    assert.equal(calls.at(-1)?.params.modelProvider, "external");
  }
});

test("reject missing, ambiguous or unsupported extension dispatch boundaries", () => {
  for (const [source, error] of [
    [
      sharedWithExtension.replace(
        extensionMethod,
        extensionMethod.replace(
          "async sendAppServerExtensionRequest(",
          "sendAppServerExtensionRequest = async function(",
        ) + ";",
      ),
      /Unexpected extension request dispatcher shape/,
    ],
    [
      sharedWithExtension.replaceAll(
        "this.enqueueRequest(method,",
        "this.unknown(method,",
      ),
      /Missing extension enqueueRequest/,
    ],
    [
      sharedWithExtension.replace(
        extensionMethod,
        extensionMethod + extensionMethod,
      ),
      /Ambiguous extension request/,
    ],
    [
      sharedWithExtension.replace(
        "{ ...request, ...extensions }, options)",
        "{ ...request, ...extensions }, options, true)",
      ),
      /Unexpected extension enqueueRequest arguments/,
    ],
  ] as const)
    assert.throws(() => transformShared(source), error);
});

test("wrap structurally matched request, prewarm, and default paths", () => {
  const result = transformShared(shared);
  assert.match(result, /intercept\(this,method,params,options/);
  assert.match(result, /prewarm\(this,params/);
  assert.match(result, /writeDefault\(this.requestClient,model/);
  assert.match(result, /this.enqueueRequest\(method, params, options\)/);
});

test("match the model filter by semantic properties, not minified names", () => {
  const result = transformPicker(picker);
  assert.match(result, /isRegisteredModel\(selected\)/);
  assert.match(result, /availableModels.has\(selected.model\)/);
  assert.match(result, /restorePickerEfforts/);
});

test("match a standalone anonymous model filter", () => {
  const anonymous = picker.replace(
    "export function visible(",
    "const visible = function(",
  );
  assert.match(transformPicker(anonymous), /isRegisteredModel\(selected\)/);
});

test("patch a nested anonymous filter while preserving native visibility and effort checks", () => {
  const patched = transformPicker(nestedPicker);
  const select = Function(
    "__codexDesktopProviders",
    `return (${patched.slice(patched.indexOf("export function select")).replace("export ", "")});`,
  )({ isRegisteredModel, restorePickerEfforts });
  const efforts = ["low", "high"].map((reasoningEffort) => ({
    reasoningEffort,
  }));
  const official = {
    model: "official",
    hidden: false,
    supportedReasoningEfforts: efforts,
  };
  const external = {
    ...official,
    model: "external",
    codexDesktopProvider: "custom",
  };
  const options = {
    models: [
      official,
      { ...official, model: "unavailable" },
      external,
      { ...external, model: "hidden-external", hidden: true },
    ],
    availableModels: new Set(["official"]),
    hasConfiguredModelCatalog: true,
    enabledReasoningEfforts: new Set(["high"]),
  };
  const result = select(options);
  assert.deepEqual(
    result.models.map((model: { model: string }) => model.model),
    ["official", "external"],
  );
  assert.deepEqual(result.models[0].supportedReasoningEfforts, [efforts[1]]);
  assert.deepEqual(result.models[1].supportedReasoningEfforts, efforts);
  assert.deepEqual(
    select({ ...options, availableModels: new Set() }).models.map(
      (model: { model: string }) => model.model,
    ),
    ["external"],
  );
});

test("a static catalog never bypasses native official-model availability checks", () => {
  const patched = transformPicker(picker);
  const source = patched.slice(
    patched.indexOf("export function visible"),
    patched.indexOf("export function select"),
  );
  const visible = Function(
    "__codexDesktopProviders",
    `return (${source.replace("export ", "")});`,
  )({ isRegisteredModel });
  const options = {
    availableModels: new Set(),
    hasConfiguredModelCatalog: true,
  };
  const official = { model: "official", hidden: false };
  assert.equal(visible({ ...options, model: official }), false);
  assert.equal(
    visible({
      ...options,
      availableModels: new Set(["official"]),
      model: official,
    }),
    true,
  );
  const external = {
    model: "external",
    hidden: false,
    codexDesktopProvider: "custom",
  };
  assert.equal(visible({ ...options, model: external }), true);
  assert.equal(
    visible({ ...options, model: { ...external, hidden: true } }),
    false,
  );
});

test("refuse absent or ambiguous structural matches and repeated injection", () => {
  assert.throws(
    () => transformShared("export const unrelated = true"),
    /found 0/,
  );
  assert.throws(
    () =>
      transformShared(
        shared +
          shared
            .replaceAll("Client", "OtherClient")
            .replaceAll("Manager", "OtherManager"),
      ),
    /found 2/,
  );
  assert.throws(
    () => transformPicker(picker.replace("?.cyber", "?.other")),
    /found 0/,
  );
  assert.throws(
    () => transformShared(transformShared(shared)),
    /already contains/,
  );
});

test("reject malformed input before producing a patch", () => {
  assert.throws(() => transformShared("function {"), SyntaxError);
});
