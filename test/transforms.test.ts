import assert from "node:assert/strict";
import test from "node:test";
import { isRegisteredModel } from "../src/runtime/registry.js";
import { transformPicker, transformShared } from "../src/patch/transforms.js";

import { shared, picker } from "./fixtures.js";

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
