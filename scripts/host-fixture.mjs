// Extract the actual hosted request/default method bodies for archive and native
// backend tests. This is a synthetic transport, never a live Desktop connection.
import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";
import { parse } from "acorn";
import { full } from "acorn-walk";
import * as runtime from "../dist/runtime/index.js";

export function hostFixture(archive, send) {
  const clients = [];
  const defaults = [];
  for (const path of listPackage(archive).filter(
    (path) =>
      !path.startsWith("/webview/") &&
      !path.startsWith("/node_modules/") &&
      /\.[cm]?js$/.test(path),
  )) {
    const source = extractFile(archive, path.slice(1)).toString();
    if (
      !source.includes("defaultTurnConfig") &&
      !source.includes("createExtensionRequest")
    )
      continue;
    full(
      parse(source, { ecmaVersion: "latest", sourceType: "module" }),
      (node) => {
        if (node.type !== "ClassBody") return;
        const methods = node.body.filter(
          (node) => node.type === "MethodDefinition",
        );
        const named = (name) =>
          methods.filter((method) => method.key.name === name);
        for (const method of named("setDefaultModelConfig")) {
          const body = source.slice(method.start, method.end);
          if (body.includes("this.defaultTurnConfig.writeModel"))
            defaults.push(body);
        }
        if (
          named("createExtensionRequest").length &&
          named("sendToConnection").length
        )
          clients.push(
            [
              "sendRequest",
              "sendAppServerExtensionRequest",
              "prewarmThreadStart",
            ].map((name) => {
              assert.equal(named(name).length, 1);
              const method = named(name)[0];
              return source.slice(method.start, method.end);
            }),
          );
      },
    );
  }
  if (!clients.length && !defaults.length) return null;
  assert.equal(clients.length, 1);
  assert.equal(defaults.length, 1);
  const methods = [...clients[0], defaults[0]];
  for (const [index, method] of methods.entries()) {
    if (index === 1) continue; // Native extension starts delegate to sendRequest.
    assert.ok(
      method.includes("__codexDesktopProviders"),
      "Exposed hosted request/default method is unpatched",
    );
  }
  const Client = Function(
    "__codexDesktopProviders",
    `return class {${methods.join("\n")}}`,
  )(() => Promise.resolve(runtime));
  const client = new Client();
  client.hostId = "local";
  client.requestClient = client;
  client.createRequest = client.createExtensionRequest = (
    method,
    params,
    trace,
  ) => ({ method, params, trace });
  client.send = (request, options, prewarm, retained) =>
    send(request.method, request.params, options, { prewarm, retained });
  client.defaultTurnConfig = {
    writeModel: async () => {
      throw new Error(
        "External selection must not persist as the global default",
      );
    },
  };
  return client;
}
