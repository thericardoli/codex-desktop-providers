import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { synchronizeCatalog } from "../src/runtime/sync.js";

const model = (slug: string, instructions = "SYNTHETIC instructions") => ({
  slug,
  display_name: slug,
  context_window: 272000,
  default_reasoning_level: "high",
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
  model_messages: { instructions_template: instructions },
});

async function fixture(
  run: (p: {
    root: string;
    native: string;
    external: string;
    output: string;
    script: string;
    marker: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "providers sync test "));
  const p = {
    root,
    native: join(root, "native.json"),
    external: join(root, "external.json"),
    output: join(root, "generated.json"),
    script: join(root, "native codex.mjs"),
    marker: join(root, "invoked.json"),
  };
  try {
    await writeFile(p.native, JSON.stringify({ models: [model("template")] }));
    await writeFile(
      p.external,
      JSON.stringify({
        template: "template",
        models: [
          { slug: "external", display_name: "External", tool_mode: "direct" },
        ],
      }),
    );
    await writeFile(
      p.script,
      `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(p.marker)}, JSON.stringify(process.argv.slice(2)));
      console.log(${JSON.stringify(JSON.stringify({ models: [model("template", "BUNDLED replacement"), model("new-native")] }))});
    `,
    );
    await run(p);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("sync adds newly bundled native models without overriding cached metadata or external settings", async () =>
  fixture(async (p) => {
    const nativeBefore = await readFile(p.native);
    const externalBefore = await readFile(p.external);
    const result = await synchronizeCatalog(p.native, p.external, p.output, {
      executable: process.execPath,
      args: [p.script],
    });
    assert.deepEqual(JSON.parse(await readFile(p.marker, "utf8")), [
      "debug",
      "models",
      "--bundled",
    ]);
    assert.deepEqual(result.sync, {
      source: "cache+bundled",
      addedModels: 1,
      warnings: [],
    });
    const generated = JSON.parse(await readFile(p.output, "utf8"));
    assert.deepEqual(generated.models.slice(0, 2), [
      model("template"),
      model("new-native"),
    ]);
    assert.equal(
      generated.models[2].model_messages.instructions_template,
      "SYNTHETIC instructions",
    );
    assert.equal(generated.models[2].tool_mode, "direct");
    assert.deepEqual(await readFile(p.native), nativeBefore);
    assert.deepEqual(await readFile(p.external), externalBefore);
    if (process.platform !== "win32")
      assert.equal((await stat(p.output)).mode & 0o777, 0o600);
    await writeFile(
      p.script,
      `console.log(${JSON.stringify(JSON.stringify({ models: [model("template"), model("next-native")] }))});`,
    );
    await synchronizeCatalog(p.native, p.external, p.output, {
      executable: process.execPath,
      args: [p.script],
    });
    assert.deepEqual(
      JSON.parse(await readFile(p.output, "utf8")).models.map(
        (m: { slug: string }) => m.slug,
      ),
      ["template", "next-native", "external"],
    );
  }));

test("sync bootstraps from the native binary when the cache is missing or malformed", async () =>
  fixture(async (p) => {
    for (const contents of [undefined, "broken JSON", '{"models":[]}']) {
      if (contents === undefined) await rm(p.native, { force: true });
      else await writeFile(p.native, contents);
      const result = await synchronizeCatalog(p.native, p.external, p.output, {
        executable: process.execPath,
        args: [p.script],
      });
      assert.equal(result.sync.source, "bundled");
      assert.equal(result.nativeModels, 2);
      if (contents === undefined)
        await assert.rejects(stat(p.native), { code: "ENOENT" });
      else assert.equal(await readFile(p.native, "utf8"), contents);
    }
  }));

test("failed, malformed, empty and timed-out exports fall back to the cache without leaking child output", async () =>
  fixture(async (p) => {
    const cases = [
      'console.error("SYNTHETIC_PRIVATE_OUTPUT"); process.exitCode = 7;',
      'console.log("not JSON");',
      "console.log(JSON.stringify({models: []}));",
      `console.log(${JSON.stringify(JSON.stringify({ models: [model("duplicate"), model("duplicate")] }))});`,
      "setInterval(() => {}, 1000);",
    ];
    for (const code of cases) {
      await writeFile(p.script, code);
      const result = await synchronizeCatalog(
        p.native,
        p.external,
        p.output,
        { executable: process.execPath, args: [p.script] },
        500,
      );
      assert.equal(result.sync.source, "cache");
      assert.equal(result.sync.warnings.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_OUTPUT/);
      assert.deepEqual(
        JSON.parse(await readFile(p.output, "utf8")).models.map(
          (m: { slug: string }) => m.slug,
        ),
        ["template", "external"],
      );
    }
    const missing = await synchronizeCatalog(p.native, p.external, p.output, {
      executable: join(p.root, "not installed"),
    });
    assert.equal(missing.sync.source, "cache");
  }));

test("sync failures preserve the last valid catalog and never write the native input", async () =>
  fixture(async (p) => {
    const command = { executable: process.execPath, args: [p.script] };
    await synchronizeCatalog(p.native, p.external, p.output, command);
    const previous = await readFile(p.output);
    await writeFile(p.script, "process.exitCode = 1;");
    await writeFile(p.native, "broken JSON");
    await assert.rejects(
      synchronizeCatalog(p.native, p.external, p.output, command),
      /No valid native cache or bundled catalog/,
    );
    assert.deepEqual(await readFile(p.output), previous);
    await writeFile(
      p.script,
      `console.log(${JSON.stringify(JSON.stringify({ models: [model("template")] }))});`,
    );
    await writeFile(p.external, '{"template":"missing","models":[]}');
    await assert.rejects(
      synchronizeCatalog(p.native, p.external, p.output, command),
      /missing template/,
    );
    assert.deepEqual(await readFile(p.output), previous);
    await rm(p.native);
    await assert.rejects(
      synchronizeCatalog(p.native, p.external, p.native, command),
      /separate/,
    );
    await assert.rejects(stat(p.native), { code: "ENOENT" });
  }));

test("sync rejects credential inputs and output links even when a bundled export is available", async () =>
  fixture(async (p) => {
    const command = { executable: process.execPath, args: [p.script] };
    const credential = join(p.root, "auth.json");
    await writeFile(credential, "SYNTHETIC_DO_NOT_READ");
    await assert.rejects(
      synchronizeCatalog(credential, p.external, p.output, command),
      /Credential files/,
    );
    await assert.rejects(stat(p.marker), { code: "ENOENT" });
    await symlink(p.native, p.output);
    await assert.rejects(
      synchronizeCatalog(p.native, p.external, p.output, command),
      /not a link/,
    );
  }));

test("concurrent native cache changes abort publication and retain the previous catalog", async () =>
  fixture(async (p) => {
    const command = { executable: process.execPath, args: [p.script] };
    await synchronizeCatalog(p.native, p.external, p.output, command);
    const previous = await readFile(p.output);
    await writeFile(
      p.script,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(p.native)}, JSON.stringify({models: [${JSON.stringify(model("concurrent-cache-update"))}]})); console.log(${JSON.stringify(JSON.stringify({ models: [model("template"), model("new-native")] }))});`,
    );
    await assert.rejects(
      synchronizeCatalog(p.native, p.external, p.output, command),
      /source changed during generation/,
    );
    assert.deepEqual(await readFile(p.output), previous);
  }));

test("CLI rejects conflicting source options before synchronization or launch", async () =>
  fixture(async (p) => {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const paths = [
      "--native-cache",
      p.native,
      "--external",
      p.external,
      "--output",
      p.output,
    ];
    for (const args of [
      ["catalog", ...paths, "--codex", "unused"],
      ["sync", ...paths, "--cache-only"],
      [
        "launch",
        ...paths,
        "--app",
        process.execPath,
        "--codex",
        "unused",
        "--cache-only",
      ],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /use --help/);
    }
    await assert.rejects(stat(p.output), { code: "ENOENT" });
    await assert.rejects(stat(p.marker), { code: "ENOENT" });
  }));

test("CLI sync reports cache fallback and launch still starts with that valid catalog", async () =>
  fixture(async (p) => {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const paths = [
      "--native-cache",
      p.native,
      "--external",
      p.external,
      "--output",
      p.output,
      "--codex",
      join(p.root, "not installed"),
    ];
    const synced = spawnSync(process.execPath, [cli, "sync", ...paths], {
      encoding: "utf8",
    });
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(JSON.parse(synced.stdout).sync.source, "cache");
    assert.match(synced.stderr, /export failed or timed out/);
    const app = join(p.root, "app.mjs");
    await writeFile(
      app,
      `import fs from "node:fs"; const catalog = JSON.parse(fs.readFileSync(${JSON.stringify(p.output)}, "utf8")); fs.writeFileSync(${JSON.stringify(p.marker)}, JSON.stringify({models: catalog.models.length, args: process.argv.slice(2)}));`,
    );
    const launched = spawnSync(
      process.execPath,
      [
        cli,
        "launch",
        ...paths,
        "--app",
        process.execPath,
        "--",
        app,
        "argument with spaces",
      ],
      { encoding: "utf8" },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(await readFile(p.marker, "utf8")), {
      models: 2,
      args: ["argument with spaces"],
    });
    await writeFile(p.external, "broken JSON");
    await rm(p.marker);
    const failed = spawnSync(
      process.execPath,
      [cli, "launch", ...paths, "--app", process.execPath, "--", app],
      { encoding: "utf8" },
    );
    assert.equal(failed.status, 1);
    await assert.rejects(stat(p.marker), { code: "ENOENT" });
  }));
