// Small synthetic fixtures, not redistributed proprietary application code.
export const shared = `export class Client {
  async sendRequest(method, params, options) {
    if (this.dispatchMessage == null) throw Error("AppServerRequestClient is missing a message dispatcher");
    return this.enqueueRequest(method, params, options);
  }
  async prewarmThreadStart(params, options) { this.dispatchMessage("warm"); return this.enqueueRequest("thread/start", params, options); }
}
export class Manager { setDefaultModelConfig(model, effort, profile) { return this.defaultTurnConfig.writeModel(model, effort, profile); } }
`;

export const extensionMethod = `async sendAppServerExtensionRequest(...[method, envelope, options]) {
  if (this.dispatchMessage == null) throw Error("AppServerRequestClient is missing a message dispatcher");
  if (method === "turn/addUserMessage") {
    if (this.hostId === "local") throw Error("User-message admission requires a cloud host");
    return this.enqueueRequest(method, envelope, { ...options, priority: "critical" });
  }
  const { request, ...extensions } = envelope;
  return this.enqueueRequest(method, { ...request, ...extensions }, options);
}`;

export const sharedWithExtension = shared.replace(
  "  async prewarmThreadStart",
  `  ${extensionMethod}\n  async prewarmThreadStart`,
);

export const hosted = `class HostedClient {
  async sendRequest(method, params, options) { return this.send(this.createRequest(method, params, options?.trace), options, false, method === "thread/start"); }
  async sendAppServerExtensionRequest(...[method, envelope, options]) {
    if (method !== "turn/addUserMessage") {
      const { request, ...extensions } = envelope;
      return this.sendRequest(method, { ...request, ...extensions }, options);
    }
    return this.send(this.createExtensionRequest(method, envelope, options?.trace), options, false, true);
  }
  async prewarmThreadStart(params, options) { return this.send(this.createRequest("thread/start", params, options?.trace), options, true, true); }
  createRequest(method, params) { return {method, params}; }
  createExtensionRequest(method, params) { return {method, params}; }
  sendToConnection() {}
}
class HostedManager {
  setDefaultModelConfig(model, effort, profile) { return this.defaultTurnConfig.writeModel(model, effort, profile); }
}
module.exports = { HostedClient, HostedManager };
`;

export const picker = `export function visible({ model: selected, availableModels, useHiddenModels, hasConfiguredModelCatalog, apiKeyDaybreakSupported }) {
  let programs = selected.availableAccessPrograms?.cyber;
  return (hasConfiguredModelCatalog || availableModels.has(selected.model)) && !selected.hidden && !programs;
}
export function select({ models: catalog, enabledReasoningEfforts, defaultModel }) {
  return { models: catalog.map(model => ({...model, supportedReasoningEfforts: model.supportedReasoningEfforts.filter(e => enabledReasoningEfforts.has(e.reasoningEffort))})), defaultModel: null };
}`;

export const nestedPicker = `export function select({ models: catalog, enabledReasoningEfforts, defaultModel, availableModels, hasConfiguredModelCatalog, useHiddenModels, apiKeyDaybreakSupported }) {
  const visible = catalog.filter(model => function({ model: selected, availableModels, useHiddenModels, hasConfiguredModelCatalog, apiKeyDaybreakSupported }) {
    let programs = selected.availableAccessPrograms?.cyber;
    return (hasConfiguredModelCatalog || availableModels.has(selected.model)) && !selected.hidden && !programs;
  }({ model, availableModels, useHiddenModels, hasConfiguredModelCatalog, apiKeyDaybreakSupported }));
  return { models: visible.map(model => ({...model, supportedReasoningEfforts: model.supportedReasoningEfforts.filter(e => enabledReasoningEfforts.has(e.reasoningEffort))})), defaultModel: null };
}`;
