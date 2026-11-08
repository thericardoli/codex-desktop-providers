import assert from "node:assert/strict";
import test from "node:test";
import {
  isRegisteredModel,
  restorePickerEfforts,
} from "../src/runtime/registry.js";
import { transformPicker, transformShared } from "../src/patch/transforms.js";

import { shared, picker, nestedPicker } from "./fixtures.js";

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
