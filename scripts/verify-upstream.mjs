// Exercise the actual patched method bodies without launching Electron or
// authenticating. No proprietary fixtures are stored in this repository.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { extractFile } from "@electron/asar";
import { parse } from "acorn";
import { full } from "acorn-walk";
import { ADAPTERS } from "../dist/patch/adapters.js";
import * as runtime from "../dist/runtime/index.js";

const { values } = parseArgs({ options: { asar: { type: "string" } } });
if (!values.asar)
  throw new Error("Expected --asar PATH to a patched disposable archive");
const archive = values.asar;
const version = JSON.parse(extractFile(archive, "package.json")).version;
const adapter = ADAPTERS.find((candidate) => candidate.version === version);
if (!adapter) throw new Error(`No adapter for ${version}`);
const shared = extractFile(archive, adapter.shared.path).toString();
const picker = extractFile(archive, adapter.picker.path).toString();
const methods = [];
full(parse(shared, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
  if (node.type !== "MethodDefinition") return;
  const source = shared.slice(node.start, node.end);
  if (
    source.includes("__codexDesktopProviders.") &&
    ["sendRequest", "prewarmThreadStart", "setDefaultModelConfig"].includes(
      node.key.name,
    )
  )
    methods.push(source);
});
assert.equal(methods.length, 3);
// The version adapter's prewarm path calls this upstream tracing helper. It is
// stubbed here so this test remains independent of Electron and telemetry.
const PatchedClient = Function(
  "__codexDesktopProviders",
  "$fn",
  `return class {${methods.join("\n")}}`,
)(runtime, () => "test");
const client = new PatchedClient();
client.hostId = "local";
client.requestClient = client;
client.dispatchMessage = () => {};
const model = "z-ai/glm-5.3-flash";
const calls = [];
client.sendConfigReadRequest = async () => ({
  config: {
    model_providers: {
      openrouter: { name: "OpenRouter", wire_api: "responses" },
    },
    profiles: {
      "glm-low": {
        model,
        model_provider: "openrouter",
        model_reasoning_effort: "low",
      },
      "glm-medium": {
        model,
        model_provider: "openrouter",
        model_reasoning_effort: "medium",
      },
      glm: {
        model,
        model_provider: "openrouter",
        model_reasoning_effort: "high",
      },
    },
  },
});
client.enqueueRequest = async (method, params, options) => {
  calls.push({ method, params, options });
  if (method === "model/list")
    return {
      data: [{ id: "gpt", model: "gpt", hidden: false }],
      nextCursor: null,
    };
  if (method === "thread/start")
    return {
      thread: {
        id: `chat-${calls.length}`,
        modelProvider: params.modelProvider ?? "openai",
      },
    };
  return {};
};
const list = await client.sendRequest("model/list", {}, {});
assert.equal(list.data.length, 2);
assert.equal(list.data[0].model, "gpt");
assert.equal(list.data[1].model, model);
assert.deepEqual(
  list.data[1].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
  ["low", "medium", "high"],
);
await client.sendRequest("thread/start", { model }, {});
assert.equal(calls.at(-1).params.modelProvider, "openrouter");
await client.prewarmThreadStart({ model }, { trace: {} });
assert.equal(calls.at(-1).params.modelProvider, "openrouter");
client.defaultTurnConfig = {
  writeModel: async () => {
    throw new Error("Custom model must not overwrite the global default");
  },
};
assert.deepEqual(await client.setDefaultModelConfig(model, "low", null), {
  status: "okOverridden",
});
await client.prewarmThreadStart({ model }, { trace: {} });
assert.equal(calls.at(-1).params.config.model_reasoning_effort, "low");
let filterSource;
let filterName;
let selectorSource;
full(parse(picker, { ecmaVersion: "latest", sourceType: "module" }), (node) => {
  if (node.type !== "FunctionDeclaration") return;
  const source = picker.slice(node.start, node.end);
  if (source.includes("__codexDesktopProviders.isRegisteredModel(")) {
    assert.equal(filterSource, undefined);
    filterSource = source;
    filterName = node.id.name;
  }
  if (source.includes("__codexDesktopProviders.restorePickerEfforts("))
    selectorSource = source;
});
assert.ok(filterSource);
const visible = Function(
  "__codexDesktopProviders",
  `return (${filterSource});`,
)(runtime);
const options = {
  additionalAvailableModels: new Set(),
  authMethod: "chatgpt",
  availableModels: new Set(),
  hasConfiguredModelCatalog: false,
  isCustomModelProvider: false,
  useHiddenModels: true,
};
assert.equal(visible({ ...options, model: list.data[0] }), false);
assert.equal(
  visible({
    ...options,
    availableModels: new Set(["gpt"]),
    model: list.data[0],
  }),
  true,
);
assert.equal(visible({ ...options, model: list.data[1] }), true);
assert.ok(selectorSource);
const select = Function(
  "__codexDesktopProviders",
  filterName,
  "Ste",
  `return (${selectorSource})`,
)(runtime, visible, () => true);
const native = {
  ...list.data[0],
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "high" },
  ],
};
const selection = select({
  ...options,
  availableModels: new Set(["gpt"]),
  models: [native, list.data[1]],
  enabledReasoningEfforts: new Set(["high"]),
  includeUltraReasoningEffort: false,
});
assert.deepEqual(selection.models[0].supportedReasoningEfforts, [
  { reasoningEffort: "high" },
]);
assert.deepEqual(
  selection.models[1].supportedReasoningEfforts.map(
    (entry) => entry.reasoningEffort,
  ),
  ["low", "medium", "high"],
);
console.log(
  `PASS ${version}: actual model filter, native entitlement filtering, model listing, direct routing, prewarm and default selection`,
);
