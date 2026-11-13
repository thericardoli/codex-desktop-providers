import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  createPackageWithOptions,
  getRawHeader,
  statFile,
} from "@electron/asar";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readText, rewriteArchive, sha256 } from "../src/patch/archive.js";
import { prepareWindows } from "../src/patch/prepare-windows.js";
import { planPatch } from "../src/patch/patch.js";
import { isWindowsAppsPath } from "../src/patch/target.js";
import { inspectWindowsIntegrity } from "../src/patch/windows-executable.js";
import { shared, picker } from "./fixtures.js";
import { windowsExecutable } from "./windows-fixtures.js";

const runtime = fileURLToPath(new URL("../src/runtime", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function fixture(
  run: (paths: {
    root: string;
    source: string;
    app: string;
    archive: string;
    output: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "providers Windows copy "));
  const source = join(root, "installed app");
  const archive = join(source, "resources", "app.asar");
  const app = join(source, "Renamed Desktop.exe");
  try {
    const assets = join(root, "assets");
    await mkdir(join(assets, "webview"), { recursive: true });
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(
      join(assets, "package.json"),
      JSON.stringify({ version: "future-windows-fixture" }),
    );
    await writeFile(join(assets, "webview", "client.js"), shared);
    await writeFile(join(assets, "webview", "picker.js"), picker);
    await writeFile(join(assets, "native.node"), "native payload");
    await createPackageWithOptions(assets, archive, { unpack: "*.node" });
    await writeFile(
      app,
      windowsExecutable(sha256(getRawHeader(archive).headerString), {
        signed: true,
      }),
    );
    await writeFile(join(source, "library.dll"), "unchanged library");
    await chmod(join(source, "library.dll"), 0o755);
    await run({
      root,
      source,
      app,
      archive,
      output: join(root, "prepared copy"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("prepare a complete copy from read-only files, synchronize integrity, and retain native payloads", async () => {
  await fixture(async ({ source, app, archive, output }) => {
    await chmod(app, 0o444);
    await chmod(archive, 0o444);
    const originalApp = await readFile(app);
    const originalAsar = await readFile(archive);
    const result = await prepareWindows(app, output, runtime);
    assert.equal(result.status, "prepared");
    assert.equal(result.app, join(output, "app", "Renamed Desktop.exe"));
    assert.equal(result.embeddedAsarIntegrity, "enabled");
    assert.equal(result.authenticode, "invalidated-in-copy");
    assert.equal(result.runtimeValidation, "not-performed");
    assert.equal(
      (await planPatch(result.asar, runtime)).status,
      "already-patched",
    );
    assert.equal(
      readText(result.asar, "package.json"),
      readText(archive, "package.json"),
    );
    assert.equal(statFile(result.asar, "native.node").unpacked, true);
    assert.equal(
      await readFile(result.asar + ".unpacked/native.node", "utf8"),
      "native payload",
    );
    assert.equal(
      await readFile(join(output, "app", "library.dll"), "utf8"),
      "unchanged library",
    );
    if (process.platform !== "win32")
      assert.equal(
        (await lstat(join(output, "app", "library.dll"))).mode & 0o777,
        0o755,
      );
    assert.equal(
      inspectWindowsIntegrity(
        await readFile(result.app),
        sha256(getRawHeader(result.asar).headerString),
      ).enabled,
      true,
    );
    assert.deepEqual(await readFile(app), originalApp);
    assert.deepEqual(await readFile(archive), originalAsar);
    assert.deepEqual(await readdir(source), [
      "Renamed Desktop.exe",
      "library.dll",
      "resources",
    ]);
    assert.deepEqual(await readdir(output), ["app"]);
    await assert.rejects(
      prepareWindows(app, output, runtime),
      /already exists/,
    );
    assert.equal(
      (await planPatch(result.asar, runtime)).status,
      "already-patched",
    );
  });
});

test("CLI prepare supports spaces and reports check scope without writing to source", async () => {
  await fixture(async ({ app, archive, output }) => {
    function run(args: string[]) {
      return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    }
    const check = run(["check", "--asar", archive]);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).checkScope, "archive-structure");
    const result = run(["prepare-windows", "--app", app, "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "prepared");
    assert.equal((await planPatch(archive, runtime)).status, "ready");
    assert.notEqual(
      run(["patch", "--asar", archive, "--output", output]).status,
      0,
    );
    assert.notEqual(
      run([
        "prepare-windows",
        "--app",
        app,
        "--output",
        output,
        "--asar",
        archive,
      ]).status,
      0,
    );
  });
});

test("reject nested outputs, invalid patch plans and mismatched executable integrity before creating output", async () => {
  await fixture(async ({ source, app, archive, output }) => {
    await assert.rejects(
      prepareWindows(app, join(source, "new", "copy"), runtime),
      /separate/,
    );
    assert.equal(await lstat(join(source, "new")).catch(() => null), null);
    await rewriteArchive(
      archive,
      new Map([["webview/duplicate.js", Buffer.from(shared)]]),
    );
    await assert.rejects(prepareWindows(app, output, runtime), /found 2/);
    assert.equal(await lstat(output).catch(() => null), null);
  });
  await fixture(async ({ app, output }) => {
    await writeFile(app, windowsExecutable("a".repeat(64)));
    await assert.rejects(
      prepareWindows(app, output, runtime),
      /does not match/,
    );
    assert.equal(await lstat(output).catch(() => null), null);
  });
});

test("reject credential files before copying application contents", async () => {
  await fixture(async ({ source, app, output }) => {
    await writeFile(join(source, "auth.json"), "synthetic forbidden file");
    await assert.rejects(prepareWindows(app, output, runtime), /auth.json/);
    assert.equal(await lstat(output).catch(() => null), null);
  });
});

test("reject incomplete unpacked native resources before creating a prepared app", async () => {
  await fixture(async ({ app, archive, output }) => {
    await rm(join(archive + ".unpacked", "native.node"));
    await assert.rejects(
      prepareWindows(app, output, runtime),
      /unpacked application file/,
    );
    assert.equal(await lstat(output).catch(() => null), null);
  });
});

test(
  "preserve internal links, reject escaping links and resolve output aliases",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(async ({ root, source, app, output }) => {
      await symlink("library.dll", join(source, "relative-link"));
      await symlink(join(source, "library.dll"), join(source, "absolute-link"));
      await symlink(source, join(root, "alias"));
      await assert.rejects(
        prepareWindows(app, join(root, "alias", "copy"), runtime),
        /separate/,
      );
      await prepareWindows(app, output, runtime);
      assert.equal(
        await readlink(join(output, "app", "relative-link")),
        "library.dll",
      );
      assert.equal(
        await readlink(join(output, "app", "absolute-link")),
        "library.dll",
      );
      await symlink(root, join(source, "escape"));
      await assert.rejects(
        prepareWindows(app, output + "-escape", runtime),
        /escapes/,
      );
      assert.equal(await lstat(output + "-escape").catch(() => null), null);
    });
  },
);

test(
  "failed copying cleans up only the new output; read-only patch errors explain the alternative",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async () => {
    await fixture(async ({ source, app, archive, output }) => {
      const blocked = join(source, "library.dll");
      await chmod(blocked, 0);
      try {
        await assert.rejects(prepareWindows(app, output, runtime), /EACCES/);
        assert.equal(await lstat(output).catch(() => null), null);
      } finally {
        await chmod(blocked, 0o755);
      }
      await chmod(dirname(archive), 0o555);
      const original = await readFile(archive);
      try {
        await assert.rejects(
          rewriteArchive(archive, new Map([["test.txt", Buffer.from("test")]])),
          /prepare-windows/,
        );
        assert.deepEqual(await readFile(archive), original);
        const result = await prepareWindows(app, output, runtime);
        assert.equal(result.status, "prepared");
      } finally {
        await chmod(dirname(archive), 0o755);
      }
    });
  },
);

test("recognize standard WindowsApps package volumes without matching unrelated directory names", () => {
  for (const path of [
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_any\\app\\resources\\app.asar",
    "D:\\WindowsApps\\package\\app.asar",
    "\\\\?\\C:\\Program Files\\WINDOWSAPPS\\package\\app.asar",
    "c:/Program Files/WindowsApps/package/app.asar",
  ])
    assert.equal(isWindowsAppsPath(path), true, path);
  for (const path of [
    "C:\\Users\\me\\WindowsApps\\app.asar",
    "C:\\WindowsApps-backup\\app.asar",
    "/tmp/WindowsApps/app.asar",
  ])
    assert.equal(isWindowsAppsPath(path), false, path);
});
