import assert from "node:assert/strict";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, planPatch } from "../src/patch/patch.js";
import { MANIFEST_PATH, RUNTIME_DIRECTORY } from "../src/patch/constants.js";
import { readText, rewriteArchive, sha256 } from "../src/patch/archive.js";
import { shared, picker } from "./fixtures.js";

const runtime = fileURLToPath(new URL("../src/runtime", import.meta.url));
const sharedPath = "webview/assets/renamed-client-abc123.js";
const pickerPath = "webview/assets/nested/menu-new.mjs";
const standard = { [sharedPath]: shared, [pickerPath]: picker };

async function fixture(
  files: Record<string, string>,
  run: (archive: string) => Promise<void>,
  version?: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "desktop-providers-plan-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify(version ? { version } : {}),
    );
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
    const archive = join(root, "app.asar");
    await createPackage(source, archive);
    await run(archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const version of ["99.123.456-future", "0.0.1-old", undefined]) {
  test(`discover renamed assets without a version allowlist (${version ?? "absent version"})`, async () => {
    await fixture(
      standard,
      async (archive) => {
        const before = sha256(await readFile(archive));
        const plan = await planPatch(archive, runtime);
        assert.equal(plan.status, "ready");
        assert.equal(plan.manifest.appVersion, version ?? "unknown");
        assert.equal(
          sha256(await readFile(archive)),
          before,
          "Planning must not write",
        );
        assert.match(
          plan.changes.get(pickerPath)!.toString(),
          /from "\.\.\/codex-desktop-providers\/index.js"/,
        );
        await applyPatch(archive, plan);
        const patched = sha256(await readFile(archive));
        const again = await planPatch(archive, runtime);
        assert.equal(again.status, "already-patched");
        assert.equal(again.changes.size, 0);
        await applyPatch(archive, again);
        assert.equal(sha256(await readFile(archive)), patched);
        assert.deepEqual(
          JSON.parse(readText(archive, MANIFEST_PATH)),
          plan.manifest,
        );
      },
      version,
    );
  });
}

test("accept changed source hashes and both roles combined in one differently named asset", async () => {
  await fixture(
    {
      "webview/assets/combined.js": `// Different upstream build\n${shared}\n${picker}`,
    },
    async (archive) => {
      const plan = await planPatch(archive, runtime);
      assert.equal(Object.keys(plan.manifest.inputs).length, 1);
      assert.equal(
        (
          plan.changes
            .get("webview/assets/combined.js")!
            .toString()
            .match(/import \* as __codexDesktopProviders/g) ?? []
        ).length,
        1,
      );
      await applyPatch(archive, plan);
      assert.equal(
        (await planPatch(archive, runtime)).status,
        "already-patched",
      );
    },
    "26.1007.71326",
  );
});

test("discover patch points split across three modules", async () => {
  const boundary = shared.indexOf("export class Manager");
  await fixture(
    {
      "webview/client.mjs": shared.slice(0, boundary),
      "webview/chunks/defaults.js": shared.slice(boundary),
      [pickerPath]: picker,
    },
    async (archive) => {
      const plan = await planPatch(archive, runtime);
      assert.equal(Object.keys(plan.manifest.inputs).length, 3);
      assert.match(
        plan.changes.get("webview/client.mjs")!.toString(),
        /from "\.\/assets\/codex-desktop-providers\/index.js"/,
      );
      await applyPatch(archive, plan);
      assert.equal(
        (await planPatch(archive, runtime)).status,
        "already-patched",
      );
    },
    "future",
  );
});

const nestedDefaults = shared
  .slice(0, shared.indexOf("export class Manager"))
  .replace(
    "return this.enqueueRequest(method, params, options);",
    "class Nested { setDefaultModelConfig(model, effort) { return this.defaultTurnConfig.writeModel(model, effort); } } return this.enqueueRequest(method, params, options);",
  );

for (const [name, files, error] of [
  [
    "overlapping patch points",
    { [sharedPath]: nestedDefaults, [pickerPath]: picker },
    /Overlapping upstream patch points/,
  ],
  ["missing patch points", { [sharedPath]: shared }, /visibility.*found 0/],
  [
    "ambiguous patch points across assets",
    { ...standard, "webview/assets/duplicate.js": shared },
    /request.*found 2/,
  ],
  [
    "malformed candidate",
    {
      ...standard,
      "webview/assets/broken.js":
        "class Client { prewarmThreadStart( // dispatchMessage",
    },
    /Cannot inspect renderer asset/,
  ],
  [
    "runtime without manifest",
    {
      ...standard,
      [`${RUNTIME_DIRECTORY}/index.js`]: "export const occupied = true",
    },
    /Runtime asset already exists/,
  ],
] as const) {
  test(`leave the original archive intact on ${name}`, async () => {
    await fixture(
      files,
      async (archive) => {
        const before = sha256(await readFile(archive));
        await assert.rejects(planPatch(archive, runtime), error);
        assert.equal(sha256(await readFile(archive)), before);
      },
      "any-version",
    );
  });
}

test("verify installed patch integrity without upstream hash expectations", async () => {
  await fixture(standard, async (archive) => {
    await applyPatch(archive, await planPatch(archive, runtime));
    await rewriteArchive(
      archive,
      new Map([[sharedPath, Buffer.from("export const damaged = true;")]]),
    );
    const damaged = sha256(await readFile(archive));
    await assert.rejects(planPatch(archive, runtime), /integrity verification/);
    assert.equal(sha256(await readFile(archive)), damaged);
  });
});

test("reject invalid installed manifests without writing", async () => {
  await fixture(standard, async (archive) => {
    await applyPatch(archive, await planPatch(archive, runtime));
    await rewriteArchive(
      archive,
      new Map([
        [MANIFEST_PATH, Buffer.from('{"schemaVersion":2,"outputs":null}')],
      ]),
    );
    const before = sha256(await readFile(archive));
    await assert.rejects(planPatch(archive, runtime), /invalid patch/);
    assert.equal(sha256(await readFile(archive)), before);
  });
});
