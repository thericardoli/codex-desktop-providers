import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  link,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeCatalog, prepareCatalog } from "../src/runtime/catalog.js";

// Synthetic native metadata only; never copy real account catalogs/prompts here.
const native = () => ({
  identity: "DO_NOT_COPY_CACHE_IDENTITY",
  fetched_at: "synthetic",
  models: [
    {
      slug: "gpt-6-sol",
      display_name: "Native Sol fixture",
      description: "Native description",
      context_window: 272000,
      max_context_window: 872000,
      effective_context_window_percent: 95,
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      model_messages: {
        instructions_template: "SYNTHETIC native instructions",
        approvals: { heading: "SYNTHETIC approvals", list: ["a", "b"] },
        collaboration_modes: { default: "SYNTHETIC default" },
      },
      input_modalities: ["text", "image"],
      support_verbosity: true,
      use_responses_lite: true,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      upgrade: { model: "native-next" },
    },
  ],
});
const external = () => ({
  template: "gpt-6-sol",
  models: [
    {
      slug: "external/model",
      display_name: "External model",
      context_window: 1048576,
      max_context_window: 1048576,
      auto_compact_token_limit: 900000,
    },
  ],
});

test("merge only external overrides while preserving every official entry", () => {
  const source = native();
  const spec = external();
  const original = structuredClone(source);
  const overrides = structuredClone(spec);
  const result = composeCatalog(source, spec);
  assert.deepEqual(Object.keys(result), ["models"]);
  assert.deepEqual(result.models.slice(0, 1), source.models);
  assert.deepEqual(result.models[1], {
    ...source.models[0],
    ...spec.models[0],
  });
  assert.deepEqual(source, original);
  assert.deepEqual(spec, overrides);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_COPY_CACHE_IDENTITY/);
});

test("inherit full model_messages and unmodified capability/transport fields", () => {
  const source = native();
  const result = composeCatalog(source, external()).models[1]!;
  assert.deepEqual(result.model_messages, source.models[0]!.model_messages);
  assert.equal(result.use_responses_lite, true);
  assert.equal(result.tool_mode, "code_mode_only");
  assert.equal(result.multi_agent_version, "v2");
  assert.deepEqual(result.input_modalities, ["text", "image"]);
  assert.equal(result.context_window, 1048576);
});

test("recursively override objects, replace arrays and preserve false/null/empty values", () => {
  const source = native();
  const spec = {
    template: "gpt-6-sol",
    models: [
      {
        ...external().models[0],
        support_verbosity: false,
        upgrade: null,
        input_modalities: [],
        model_messages: { instructions_template: "", approvals: { list: [] } },
      },
    ],
  };
  const result = composeCatalog(source, spec).models[1]!;
  assert.equal(result.support_verbosity, false);
  assert.equal(result.upgrade, null);
  assert.deepEqual(result.input_modalities, []);
  assert.deepEqual(result.model_messages, {
    ...source.models[0]!.model_messages,
    instructions_template: "",
    approvals: { heading: "SYNTHETIC approvals", list: [] },
  });
});

test("reject missing templates, native collisions and duplicate IDs", () => {
  assert.throws(
    () => composeCatalog(native(), { ...external(), template: "missing" }),
    /missing template/,
  );
  assert.throws(
    () => composeCatalog({ models: [] }, external()),
    /missing template/,
  );
  assert.throws(
    () =>
      composeCatalog(native(), {
        ...external(),
        models: [{ ...external().models[0], slug: "gpt-6-sol" }],
      }),
    /collides/,
  );
  assert.throws(
    () =>
      composeCatalog(
        { models: [...native().models, ...native().models] },
        external(),
      ),
    /duplicate model/,
  );
  assert.throws(
    () =>
      composeCatalog(native(), {
        ...external(),
        models: [...external().models, ...external().models],
      }),
    /duplicate model/,
  );
});

test("validate external budgets, identity and reasoning without altering native metadata", () => {
  for (const override of [
    { slug: " external/model" },
    { display_name: "" },
    { context_window: 0 },
    { context_window: 0.5 },
    { max_context_window: 1000 },
    { auto_compact_token_limit: -1 },
    { effective_context_window_percent: 101 },
    { default_reasoning_level: "max" },
    { supported_reasoning_levels: [] },
    { auth: {} },
    { model_provider: "custom" },
  ])
    assert.throws(() =>
      composeCatalog(native(), {
        ...external(),
        models: [{ ...external().models[0], ...override }],
      }),
    );
  const unsafe = JSON.parse(
    '{"template":"gpt-6-sol","models":[{"slug":"external","display_name":"External","model_messages":{"__proto__":{"polluted":true}}}]}',
  );
  assert.throws(() => composeCatalog(native(), unsafe), /Invalid override key/);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

async function files(
  run: (paths: {
    root: string;
    native: string;
    external: string;
    output: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "providers-catalog-test-"));
  const paths = {
    root,
    native: join(root, "native.json"),
    external: join(root, "external.json"),
    output: join(root, "generated.json"),
  };
  try {
    await writeFile(paths.native, JSON.stringify(native()));
    await writeFile(paths.external, JSON.stringify(external()));
    await run(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("regenerate from the latest native cache and external file on each launch preparation", async () =>
  files(async (p) => {
    const result = await prepareCatalog(p.native, p.external, p.output);
    assert.equal(result.nativeModels, 1);
    assert.equal(result.externalModels, 1);
    assert.equal((await stat(p.output)).mode & 0o777, 0o600);
    const updated = native();
    updated.models[0]!.model_messages.instructions_template =
      "NEW SYNTHETIC instructions";
    updated.models.push({ ...updated.models[0]!, slug: "new-official" });
    await writeFile(p.native, JSON.stringify(updated));
    await prepareCatalog(p.native, p.external, p.output);
    const generated = JSON.parse(await readFile(p.output, "utf8"));
    assert.deepEqual(generated.models.slice(0, 2), updated.models);
    assert.equal(
      generated.models[2].model_messages.instructions_template,
      "NEW SYNTHETIC instructions",
    );
  }));

test("generation failures leave the previous catalog and input files intact", async () =>
  files(async (p) => {
    await prepareCatalog(p.native, p.external, p.output);
    const previous = await readFile(p.output);
    await writeFile(p.external, "broken JSON");
    await assert.rejects(
      prepareCatalog(p.native, p.external, p.output),
      /invalid JSON/,
    );
    assert.deepEqual(await readFile(p.output), previous);
    await writeFile(
      p.external,
      JSON.stringify({ ...external(), template: "missing" }),
    );
    await assert.rejects(
      prepareCatalog(p.native, p.external, p.output),
      /missing template/,
    );
    assert.deepEqual(await readFile(p.output), previous);
  }));

test("refuse source aliases, output symlinks and credential-file inputs", async () =>
  files(async (p) => {
    const original = await readFile(p.native);
    await assert.rejects(
      prepareCatalog(p.native, p.external, p.native),
      /separate/,
    );
    await symlink(p.native, p.output);
    await assert.rejects(
      prepareCatalog(p.native, p.external, p.output),
      /not a link/,
    );
    await rm(p.output);
    await link(p.native, p.output);
    await assert.rejects(
      prepareCatalog(p.native, p.external, p.output),
      /alias/,
    );
    assert.deepEqual(await readFile(p.native), original);
    const credential = join(p.root, "auth.json");
    await writeFile(credential, "{}");
    await assert.rejects(
      prepareCatalog(credential, p.external, p.output),
      /Credential files/,
    );
  }));

test("launcher prepares before starting, forwards arguments, and preserves exit status", async () =>
  files(async (p) => {
    const marker = join(p.root, "started.json");
    const app = join(p.root, "app.mjs");
    await writeFile(
      app,
      `import fs from 'node:fs'; const catalog=JSON.parse(fs.readFileSync(${JSON.stringify(p.output)},'utf8')); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),models:catalog.models.length})); process.exitCode=7;`,
    );
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const args = [
      cli,
      "launch",
      "--native-cache",
      p.native,
      "--external",
      p.external,
      "--output",
      p.output,
      "--app",
      process.execPath,
      "--",
      app,
      "argument with spaces",
      "--app-flag",
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      args: ["argument with spaces", "--app-flag"],
      models: 2,
    });
    await rm(marker);
    await writeFile(p.external, "{}");
    const failed = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(failed.status, 1);
    await assert.rejects(stat(marker), { code: "ENOENT" });
  }));
