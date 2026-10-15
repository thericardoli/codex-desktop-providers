// End-to-end native Codex transport test against a disposable localhost upstream.
// No user config, credentials, external inference, or application launch is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { intercept, writeDefault } from "../dist/runtime/index.js";

const { values } = parseArgs({ options: { codex: { type: "string" } } });
if (!values.codex) throw new Error("Expected --codex /path/to/native/codex");
const model = "z-ai/glm-5.3-flash";
const temporary = await mkdtemp(
  join(tmpdir(), "desktop-providers-app-server-"),
);
const received = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, "Bearer local-smoke-key");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, model);
    assert.equal(body.reasoning?.effort, ["low", "max"][received.length]);
    assert.ok(Array.isArray(body.tools));
    received.push(body);
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
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
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
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.smoke]
name = "Local smoke upstream"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
env_key = "DESKTOP_PROVIDERS_SMOKE_KEY"
[profiles.smoke]
model = "${model}"
model_name = "GLM 5.3 Flash"
model_provider = "smoke"
model_reasoning_effort = "high"
[profiles.smoke-low]
model = "${model}"
model_provider = "smoke"
model_reasoning_effort = "low"
[profiles.smoke-max]
model = "${model}"
model_provider = "smoke"
model_reasoning_effort = "max"
`,
  { mode: 0o600 },
);

const child = spawn(values.codex, ["app-server", "--listen", "stdio://"], {
  env: {
    ...process.env,
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
    ephemeral: true,
  });
  assert.equal(started.thread.modelProvider, "smoke");
  for (const effort of ["low", "max"]) {
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
  }
  assert.equal(received.length, 2);
  const config = await raw("config/read", { includeLayers: true, cwd: null });
  assert.equal(config.config.model_provider ?? "openai", "openai");
  assert.equal(config.config.profiles.smoke.model_name, undefined);
  assert.equal(
    config.layers.find((layer) => layer.name.type === "user").config.profiles
      .smoke.model_name,
    "GLM 5.3 Flash",
  );
  console.log(
    "PASS native app-server: registered profile → thread provider → direct authenticated Responses request → streamed completion; global provider remains OpenAI",
  );
} finally {
  clearTimeout(deadline);
  child.kill();
  lines.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
