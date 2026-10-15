import assert from "node:assert/strict";
import test from "node:test";
import { transformPicker, transformShared } from "../src/patch/transforms.js";

// Small synthetic fixtures, not redistributed proprietary application code.
const shared = `export class Client {
  async sendRequest(method, params, options) {
    if (this.dispatchMessage == null) throw Error("AppServerRequestClient is missing a message dispatcher");
    return this.enqueueRequest(method, params, options);
  }
  async prewarmThreadStart(params, options) { this.dispatchMessage("warm"); return this.enqueueRequest("thread/start", params, options); }
}
export class Manager { setDefaultModelConfig(model, effort, profile) { return this.defaultTurnConfig.writeModel(model, effort, profile); } }
`;

const picker = `export function visible({ model: selected, availableModels, useHiddenModels, hasConfiguredModelCatalog, apiKeyDaybreakSupported }) {
  let programs = selected.availableAccessPrograms?.cyber;
  return availableModels.has(selected.model) && !selected.hidden && !programs;
}
export function select({ models: catalog, enabledReasoningEfforts, defaultModel }) {
  return { models: catalog.map(model => ({...model, supportedReasoningEfforts: model.supportedReasoningEfforts.filter(e => enabledReasoningEfforts.has(e.reasoningEffort))})), defaultModel: null };
}`;

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
