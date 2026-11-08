// Exercise the actual patched method bodies without launching Electron or
// authenticating. No proprietary fixtures are stored in this repository.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { extractFile } from "@electron/asar";
import { parse } from "acorn";
import { full } from "acorn-walk";
import { MANIFEST_PATH } from "../dist/patch/constants.js";
import * as runtime from "../dist/runtime/index.js";

const { values } = parseArgs({ options: { asar: { type: "string" } } });
if (!values.asar)
  throw new Error("Expected --asar PATH to a patched disposable archive");
const archive = values.asar;
const version = JSON.parse(extractFile(archive, "package.json")).version;
const manifest = JSON.parse(extractFile(archive, MANIFEST_PATH));
const sources = Object.keys(manifest.inputs).map((path) =>
  extractFile(archive, path).toString(),
);
const methods = [];
for (const shared of sources)
  full(
    parse(shared, { ecmaVersion: "latest", sourceType: "module" }),
    (node) => {
      if (node.type !== "MethodDefinition") return;
      const source = shared.slice(node.start, node.end);
      if (
        source.includes("__codexDesktopProviders.") &&
        ["sendRequest", "prewarmThreadStart", "setDefaultModelConfig"].includes(
          node.key.name,
        )
      )
        methods.push(source);
    },
  );
assert.equal(methods.length, 3);
// Locate the prewarm source-label helper structurally; minified names change.
// The explicit trace passed below avoids initializing Electron telemetry.
const traceSources = new Set();
full(
  parse(`class Fixture {${methods.join("\n")}}`, { ecmaVersion: "latest" }),
  (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
      return;
    const arg = node.arguments[0];
    const value =
      arg?.type === "Literal"
        ? arg.value
        : arg?.type === "TemplateLiteral" && arg.expressions.length === 0
          ? arg.quasis[0].value.cooked
          : undefined;
    if (value === "thread/start") traceSources.add(node.callee.name);
  },
);
assert.equal(traceSources.size, 1);
const PatchedClient = Function(
  "__codexDesktopProviders",
  ...traceSources,
  `return class {${methods.join("\n")}}`,
)(runtime, ...[...traceSources].map(() => () => "test"));
const client = new PatchedClient();
client.hostId = "local";
client.requestClient = client;
client.dispatchMessage = () => {};
const model = "z-ai/glm-5.3-flash";
const calls = [];
client.sendConfigReadRequest = async () => ({
  config: {
    model: "gpt",
    model_catalog_json: "/synthetic/models.json",
    model_providers: {
      openrouter: { name: "OpenRouter", wire_api: "responses" },
    },
    profiles: { glm: { model, model_provider: "openrouter" } },
  },
});
client.enqueueRequest = async (method, params, options) => {
  calls.push({ method, params, options });
  if (method === "model/list")
    return {
      data: [
        { id: "gpt", model: "gpt", hidden: false },
        {
          id: model,
          model,
          displayName: "GLM 5.3 Flash",
          hidden: false,
          supportedReasoningEfforts: ["low", "high", "max"].map(
            (reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            }),
          ),
          defaultReasoningEffort: "high",
          inputModalities: ["text"],
        },
      ],
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
assert.equal(list.data[1].id, model);
assert.equal(list.data[1].displayName, "GLM 5.3 Flash (OpenRouter)");
assert.deepEqual(
  list.data[1].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
  ["low", "high", "max"],
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
for (const picker of sources)
  full(
    parse(picker, { ecmaVersion: "latest", sourceType: "module" }),
    (node) => {
      if (node.type !== "FunctionDeclaration") return;
      const source = picker.slice(node.start, node.end);
      if (source.includes("__codexDesktopProviders.isRegisteredModel(")) {
        assert.equal(filterSource, undefined);
        filterSource = source;
        filterName = node.id.name;
      }
      if (source.includes("__codexDesktopProviders.restorePickerEfforts("))
        selectorSource = source;
    },
  );
assert.ok(filterSource);
const visible = Function(
  "__codexDesktopProviders",
  `return (${filterSource});`,
)(runtime);
const options = {
  additionalAvailableModels: new Set(),
  authMethod: "chatgpt",
  availableModels: new Set(),
  hasConfiguredModelCatalog: true,
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
const effortPredicates = new Set();
full(parse(`(${selectorSource})`, { ecmaVersion: "latest" }), (node) => {
  if (
    node.type === "LogicalExpression" &&
    node.operator === "&&" &&
    node.left.type === "CallExpression" &&
    node.left.callee.type === "Identifier" &&
    node.left.arguments.length === 1 &&
    node.left.arguments[0].type === "Identifier"
  )
    effortPredicates.add(node.left.callee.name);
});
assert.equal(effortPredicates.size, 1);
const select = Function(
  "__codexDesktopProviders",
  filterName,
  ...effortPredicates,
  `return (${selectorSource})`,
)(runtime, visible, ...[...effortPredicates].map(() => () => true));
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
assert.equal(selection.models[1].displayName, "GLM 5.3 Flash (OpenRouter)");
assert.equal(selection.models[1].model, model);
assert.deepEqual(selection.models[0].supportedReasoningEfforts, [
  { reasoningEffort: "high" },
]);
assert.deepEqual(
  selection.models[1].supportedReasoningEfforts.map(
    (entry) => entry.reasoningEffort,
  ),
  ["low", "high", "max"],
);
console.log(
  `PASS ${version}: actual model filter, native entitlement filtering, model listing, direct routing, prewarm and default selection`,
);
