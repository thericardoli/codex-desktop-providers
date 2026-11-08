// End-to-end native Codex transport test against a disposable localhost upstream.
// No user config, credentials, external inference, or application launch is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { intercept, writeDefault } from "../dist/runtime/index.js";
import { prepareCatalog } from "../dist/runtime/catalog.js";

const { values } = parseArgs({ options: { codex: { type: "string" } } });
if (!values.codex) throw new Error("Expected --codex /path/to/native/codex");
const model = "z-ai/glm-5.3-flash";
const temporary = await mkdtemp(
  join(tmpdir(), "desktop-providers-app-server-"),
);
const received = [];
const catalogPath = join(temporary, "models.json");
const example = JSON.parse(
  await readFile(new URL("../examples/models.json", import.meta.url), "utf8"),
);
const custom = example.models[0];
assert.equal(custom.slug, model);
const template = {
  ...custom,
  slug: "gpt-6-sol",
  display_name: "Synthetic template",
  model_messages: {
    instructions_template:
      "SYNTHETIC inherited model instructions for a localhost transport fixture.",
  },
};
const nativePath = join(temporary, "native-cache.json");
await writeFile(
  nativePath,
  JSON.stringify({
    models: [
      {
        ...custom,
        slug: "native-default",
        display_name: "Synthetic native model",
        priority: 0,
        context_window: 272000,
        max_context_window: 272000,
        auto_compact_token_limit: null,
      },
      template,
    ],
  }),
);
const externalPath = new URL(
  "../examples/external-models.json",
  import.meta.url,
);
await prepareCatalog(nativePath, externalPath.pathname, catalogPath);
const generated = JSON.parse(await readFile(catalogPath, "utf8"));
assert.deepEqual(
  generated.models.find((entry) => entry.slug === model).model_messages,
  template.model_messages,
);
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer local-smoke-key");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, model);
    assert.equal(
      body.reasoning?.effort,
      ["low", "max", "max", "max"][received.length],
    );
    assert.ok(Array.isArray(body.tools));
    if (received.length === 0) {
      assert.equal(
        request.headers["x-openai-internal-codex-responses-lite"],
        undefined,
      );
      assert.ok(body.tools.length > 0);
      assert.ok(
        JSON.stringify(body).includes(
          template.model_messages.instructions_template,
        ),
      );
    }
    received.push(body);
    // Synthetic usage crosses the catalog's 900K threshold without sending a
    // huge prompt: 800K must not compact; 900001 must compact before turn 3.
    const inputTokens =
      received.length === 1 ? 800000 : received.length === 2 ? 900001 : 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const message = {
      id: "msg_smoke",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "local-smoke-ok", annotations: [] },
      ],
    };
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_smoke", status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "local-smoke-ok",
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_smoke",
          status: "completed",
          model,
          output: [message],
          usage: {
            input_tokens: inputTokens,
            output_tokens: 1,
            total_tokens: inputTokens + 1,
          },
        },
      },
    ])
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    response.end();
  } catch (error) {
    response.writeHead(500);
    response.end("Local test upstream rejected the request");
    server.emit("testFailure", error);
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
await writeFile(
  join(temporary, "config.toml"),
  `
model = "native-default"
model_catalog_json = ${JSON.stringify(catalogPath)}
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.smoke]
name = "Local smoke upstream"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
env_key = "DESKTOP_PROVIDERS_SMOKE_KEY"
[profiles.smoke]
model = "${model}"
model_provider = "smoke"
`,
  { mode: 0o600 },
);

const child = spawn(values.codex, ["app-server", "--listen", "stdio://"], {
  env: {
    PATH: process.env.PATH,
    HOME: temporary,
    CODEX_HOME: temporary,
    DESKTOP_PROVIDERS_SMOKE_KEY: "local-smoke-key",
  },
  stdio: ["pipe", "pipe", "ignore"],
});
const pending = new Map();
const notifications = [];
let sequence = 0;
let fatal;
server.on("testFailure", (error) => {
  fatal = error;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else notifications.push(message);
});
const raw = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
const client = {
  hostId: "local",
  sendRequest: (method, params, options) =>
    intercept(client, method, params, options, raw),
};
const deadline = setTimeout(() => {
  child.kill();
}, 30_000);
child.on("exit", () => {
  for (const { reject } of pending.values())
    reject(new Error("Native app-server exited"));
});
try {
  await raw("initialize", {
    clientInfo: { name: "desktop_provider_smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(
    JSON.stringify({ method: "initialized", params: {} }) + "\n",
  );
  const catalog = await client.sendRequest("model/list", {
    includeHidden: true,
    limit: 100,
  });
  const named = catalog.data.find((entry) => entry.model === model);
  assert.equal(named?.displayName, "GLM 5.3 Flash (Local smoke upstream)");
  assert.equal(named?.id, model);
  await writeDefault(client, model, "low", async () => {
    throw Error("Global model default must not be written");
  });
  const started = await client.sendRequest("thread/start", {
    model,
    cwd: temporary,
    ephemeral: false,
  });
  assert.equal(started.thread.modelProvider, "smoke");
  for (const [index, effort] of ["low", "max", "max"].entries()) {
    const turn = await client.sendRequest("turn/start", {
      threadId: started.thread.id,
      model,
      ...(effort === "low"
        ? { effort }
        : {
            collaborationMode: {
              mode: "default",
              settings: {
                model,
                reasoning_effort: effort,
                developer_instructions: null,
              },
            },
          }),
      input: [
        { type: "text", text: "Reply with local-smoke-ok. Do not use tools." },
      ],
    });
    const timeoutAt = Date.now() + 15_000;
    while (
      !notifications.some(
        (entry) =>
          entry.method === "turn/completed" &&
          entry.params.turn.id === turn.turn.id,
      ) &&
      Date.now() < timeoutAt
    ) {
      if (fatal) throw fatal;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (fatal) throw fatal;
    const completed = notifications.find(
      (entry) =>
        entry.method === "turn/completed" &&
        entry.params.turn.id === turn.turn.id,
    );
    assert.ok(completed, "Native inference must complete");
    assert.equal(completed.params.turn.status, "completed");
    assert.equal(received.length, [1, 2, 4][index]);
    assert.equal(
      notifications.filter(
        (entry) =>
          entry.method === "item/completed" &&
          entry.params.item.type === "contextCompaction",
      ).length,
      index === 2 ? 1 : 0,
    );
  }
  for (const method of ["thread/resume", "thread/fork"]) {
    const result = await client.sendRequest(method, {
      threadId: started.thread.id,
      model,
    });
    assert.equal(result.thread.modelProvider, "smoke");
  }
  const config = await raw("config/read", { includeLayers: true, cwd: null });
  assert.equal(config.config.model_provider ?? "openai", "openai");
  assert.equal(config.config.model_catalog_json, catalogPath);
  const windows = notifications
    .filter((entry) => entry.method === "thread/tokenUsage/updated")
    .map((entry) => entry.params.tokenUsage.modelContextWindow);
  assert.ok(windows.length >= 3);
  assert.ok(
    windows.every((window) => window === 996147),
    JSON.stringify(windows),
  );
  assert.ok(catalog.data.some((entry) => entry.model === "native-default"));
  console.log(
    "PASS native app-server: JSON catalog, profile routing, low/max effort, 996147 usable context, 900K auto-compaction, resume/fork; global provider remains OpenAI",
  );
} finally {
  clearTimeout(deadline);
  child.kill();
  lines.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
