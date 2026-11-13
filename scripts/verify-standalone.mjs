// Exercise the extracted native package with no Node/npm/compiler on PATH.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { shared, picker } from "../test/fixtures.ts";
import { windowsExecutable } from "../test/windows-fixtures.ts";

const { values } = parseArgs({
  options: {
    input: { type: "string", default: "release" },
    revision: { type: "string" },
  },
});
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const runtime = JSON.parse(
  await readFile(new URL("./node-runtime.json", import.meta.url), "utf8"),
);
const platforms = { linux: "linux", darwin: "macos", win32: "windows" };
const target = `${platforms[process.platform]}-${process.arch}`;
const windows = process.platform === "win32";
const tar = windows
  ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";
const name = `${pkg.name}-${pkg.version}-${target}`;
const filename = `${name}.${windows ? "zip" : "tar.gz"}`;
const input = resolve(values.input);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  (await readFile(join(input, `SHA256SUMS.${target}`), "utf8")).trim(),
  `${sha256(await readFile(join(input, filename)))}  ${filename}`,
);
const temporary = await mkdtemp(
  join(tmpdir(), "providers standalone with spaces "),
);
try {
  execFileSync(tar, ["-xf", join(input, filename), "-C", temporary]);
  const root = join(temporary, name);
  const metadata = JSON.parse(
    await readFile(join(root, "release.json"), "utf8"),
  );
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.sourceRevision, values.revision);
  assert.equal(metadata.runtime.target, target);
  assert.equal(metadata.runtime.sha256, runtime.targets[target]);
  assert.ok((await readFile(join(root, "runtime/LICENSE"))).length > 1000);
  const emptyPath = join(temporary, "empty-path");
  await mkdir(emptyPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["path", "node_path", "node_options"].includes(key.toLowerCase()),
    ),
  );
  env.PATH = emptyPath;
  const node = join(root, "runtime", windows ? "node.exe" : "node");
  const actual = spawnSync(
    node,
    [
      "-p",
      "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(actual.status, 0, actual.error?.message ?? actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), {
    version: `v${runtime.version}`,
    platform: process.platform,
    arch: process.arch,
  });
  const launcher = join(
    root,
    `codex-desktop-providers${windows ? ".cmd" : ""}`,
  );
  function run(args, success = true) {
    const result = windows
      ? spawnSync(
          process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `"${[launcher, ...args].map((arg) => `"${arg}"`).join(" ")}"`,
          ],
          { env, encoding: "utf8", windowsVerbatimArguments: true },
        )
      : spawnSync(launcher, args, { env, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status === 0,
      success,
      result.error?.message ?? result.stderr,
    );
    return result.stdout;
  }
  assert.match(run(["--help"]), /Usage:/);
  run(["invalid-command"], false);
  const asar = await import(
    pathToFileURL(join(root, "node_modules/@electron/asar/lib/asar.js"))
  );
  const source = join(temporary, "synthetic desktop");
  await mkdir(join(source, "webview/assets"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ version: "future-synthetic" }),
  );
  await writeFile(join(source, "webview/assets/client.js"), shared);
  await writeFile(join(source, "webview/assets/picker.js"), picker);
  await writeFile(join(source, "untouched.txt"), "synthetic unrelated payload");
  const archive = join(temporary, "synthetic desktop.asar");
  await asar.createPackage(source, archive);
  const original = sha256(await readFile(archive));
  assert.equal(JSON.parse(run(["check", "--asar", archive])).status, "ready");
  assert.equal(
    sha256(await readFile(archive)),
    original,
    "check must not write",
  );
  const windowsApp = join(temporary, "synthetic Windows app");
  await mkdir(join(windowsApp, "resources"), { recursive: true });
  const windowsArchive = join(windowsApp, "resources", "app.asar");
  const windowsExe = join(windowsApp, "Desktop.exe");
  await copyFile(archive, windowsArchive);
  const executableBytes = windowsExecutable(
    sha256(asar.getRawHeader(archive).headerString),
  );
  await writeFile(windowsExe, executableBytes);
  await writeFile(join(windowsApp, "native.dll"), "unmodified synthetic DLL");
  const prepared = JSON.parse(
    run([
      "prepare-windows",
      "--app",
      windowsExe,
      "--output",
      join(temporary, "prepared Windows copy"),
    ]),
  );
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.embeddedAsarIntegrity, "enabled");
  assert.equal(
    JSON.parse(run(["check", "--asar", prepared.asar])).status,
    "already-patched",
  );
  assert.equal(sha256(await readFile(windowsArchive)), original);
  assert.deepEqual(await readFile(windowsExe), executableBytes);
  assert.ok(
    (await readFile(prepared.app)).includes(
      Buffer.from(sha256(asar.getRawHeader(prepared.asar).headerString)),
    ),
  );
  assert.equal(
    await readFile(
      join(temporary, "prepared Windows copy", "app", "native.dll"),
      "utf8",
    ),
    "unmodified synthetic DLL",
  );
  assert.equal(JSON.parse(run(["patch", "--asar", archive])).status, "patched");
  assert.equal(
    JSON.parse(run(["check", "--asar", archive])).status,
    "already-patched",
  );
  asar.uncache(archive);
  assert.equal(
    asar.extractFile(archive, "untouched.txt").toString(),
    "synthetic unrelated payload",
  );
  assert.equal(
    JSON.parse(
      asar.extractFile(archive, "codex-desktop-providers.json").toString(),
    ).patchVersion,
    pkg.version,
  );
  const native = {
    models: [
      {
        slug: "gpt-6-sol",
        display_name: "Synthetic native",
        context_window: 272000,
        max_context_window: 872000,
        model_messages: {
          instructions_template: "SYNTHETIC native model instructions",
        },
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "high", description: "High" }],
      },
    ],
  };
  const nativePath = join(temporary, "native cache.json");
  const externalPath = join(temporary, "external models.json");
  const output = join(temporary, "generated catalog.json");
  await writeFile(nativePath, JSON.stringify(native));
  await writeFile(
    externalPath,
    JSON.stringify({
      template: "gpt-6-sol",
      models: [{ slug: "external/model", display_name: "Synthetic external" }],
    }),
  );
  const catalogArgs = [
    "catalog",
    "--native-cache",
    nativePath,
    "--external",
    externalPath,
    "--output",
    output,
  ];
  run(catalogArgs);
  const catalog = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(catalog.models[0], native.models[0]);
  assert.equal(catalog.models[1].slug, "external/model");
  await writeFile(
    externalPath,
    JSON.stringify({
      template: "gpt-6-sol",
      models: [
        { slug: "external/model", display_name: "Updated synthetic external" },
      ],
    }),
  );
  run(catalogArgs);
  assert.equal(
    JSON.parse(await readFile(output, "utf8")).models[1].display_name,
    "Updated synthetic external",
  );
  const validCatalog = await readFile(output);
  await writeFile(
    externalPath,
    JSON.stringify({ template: "missing", models: [] }),
  );
  run(catalogArgs, false);
  assert.deepEqual(
    await readFile(output),
    validCatalog,
    "Failed catalog generation preserves the previous output",
  );
  assert.deepEqual(JSON.parse(await readFile(nativePath, "utf8")), native);
  console.log(
    `PASS ${target}: bundled Node, empty PATH, paths with spaces, exit status, catalog, Windows copy preparation/integrity, ASAR check/patch/idempotence and independent ASAR reader`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
