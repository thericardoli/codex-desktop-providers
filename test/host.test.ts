import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits } from "../src/patch/transforms.js";
import { findHostPatchEdits } from "../src/patch/host-transforms.js";
import { hosted } from "./fixtures.js";
import type { JsonObject } from "../src/runtime/types.js";

test("load the shared runtime from a CommonJS host and route native extension starts, defaults and prewarming", async () => {
  const root = await mkdtemp(join(tmpdir(), "providers-commonjs-host-"));
  try {
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    for (const file of ["index.js", "registry.js", "types.js"])
      await copyFile(
        new URL(`../src/runtime/${file}`, import.meta.url),
        join(runtime, file),
      );
    await writeFile(join(runtime, "package.json"), '{"type":"module"}\n');
    const file = join(root, "host.cjs");
    const edits = findHostPatchEdits(hosted);
    assert.deepEqual(edits.map((edit) => edit.point).sort(), [
      "host-defaults",
      "host-prewarm",
      "host-request",
    ]);
    await writeFile(
      file,
      applyEdits(hosted, edits, "./runtime/index.js", true),
    );
    const { HostedClient, HostedManager } = (
      await import(pathToFileURL(file).href)
    ).default;
    const client = new HostedClient();
    client.hostId = "local";
    const calls: {
      method: string;
      params: JsonObject;
      prewarm: boolean;
      options: unknown;
    }[] = [];
    client.send = async (
      request: { method: string; params: JsonObject },
      options: unknown,
      prewarm: boolean,
    ) => {
      calls.push({ ...request, options, prewarm });
      if (request.method === "config/read")
        return {
          config: {
            model: "official",
            model_catalog_json: "/synthetic/catalog.json",
            model_providers: { custom: { wire_api: "responses" } },
            profiles: {
              custom: { model: "external", model_provider: "custom" },
            },
          },
        };
      if (request.method === "model/list")
        return {
          data: [
            {
              model: "external",
              displayName: "External",
              supportedReasoningEfforts: [
                { reasoningEffort: "high" },
                { reasoningEffort: "low" },
              ],
              defaultReasoningEffort: "high",
            },
          ],
          nextCursor: null,
        };
      if (request.method === "thread/start")
        return {
          thread: {
            id: "new",
            modelProvider: request.params.modelProvider ?? "openai",
          },
        };
      if (request.method === "thread/read")
        return {
          thread: { id: request.params.threadId, modelProvider: "openai" },
        };
      return {};
    };
    const manager = new HostedManager();
    manager.requestClient = client;
    let writes = 0;
    manager.defaultTurnConfig = {
      writeModel: async () => {
        writes++;
        return { status: "ok" };
      },
    };
    assert.deepEqual(
      await manager.setDefaultModelConfig("external", "low", null),
      { status: "okOverridden" },
    );
    assert.equal(writes, 0);
    const options = { trace: {}, priority: "critical" };
    const started = await client.sendAppServerExtensionRequest(
      "thread/start",
      {
        request: { model: "external" },
        daybreakProgramPropagationEnrolled: false,
      },
      options,
    );
    assert.equal(started.thread.modelProvider, "custom");
    assert.deepEqual(calls.at(-1)?.params, {
      model: "external",
      modelProvider: "custom",
      config: { model_reasoning_effort: "low" },
      daybreakProgramPropagationEnrolled: false,
    });
    assert.equal(calls.at(-1)?.options, options);
    await client.sendRequest("turn/start", {
      threadId: "new",
      model: "external",
    });
    assert.equal(
      calls.some((call) => call.method === "thread/read"),
      false,
    );
    await assert.rejects(
      client.sendRequest("turn/start", { threadId: "new", model: "official" }),
      /Start a new chat/,
    );
    await client.prewarmThreadStart({ model: "external" }, options);
    assert.equal(calls.at(-1)?.prewarm, true);
    assert.equal(calls.at(-1)?.params.modelProvider, "custom");
    assert.equal(
      (calls.at(-1)?.params.config as JsonObject).model_reasoning_effort,
      "low",
    );
    await manager.setDefaultModelConfig("official", "high", null);
    assert.equal(writes, 1);
    client.hostId = "remote";
    await client.sendRequest("thread/start", { model: "external" });
    assert.deepEqual(calls.at(-1)?.params, { model: "external" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reject hosted extension layouts that bypass the wrapped request path", () => {
  assert.throws(
    () =>
      findHostPatchEdits(
        hosted.replace(
          "this.sendRequest(method, { ...request, ...extensions }, options)",
          "this.unknown(method, request)",
        ),
      ),
    /Unexpected hosted dispatcher structure/,
  );
});
