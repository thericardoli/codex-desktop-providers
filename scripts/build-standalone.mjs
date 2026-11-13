// Assemble a native package from the compiled tool and an official Node binary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string", default: "release" },
    output: { type: "string", default: "release" },
    target: { type: "string" },
    tag: { type: "string" },
    revision: { type: "string" },
  },
});
const platforms = { linux: "linux", darwin: "macos", win32: "windows" };
const target = `${platforms[process.platform]}-${process.arch}`;
assert.equal(
  values.target,
  target,
  "Build and verify on the target OS/architecture",
);
assert.match(
  values.revision ?? "",
  /^[0-9a-f]{40}$/,
  "Expected --revision FULL_SHA",
);
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (values.tag)
  assert.equal(values.tag, `v${pkg.version}`, "Tag must match package version");
const runtime = JSON.parse(
  await readFile(new URL("./node-runtime.json", import.meta.url), "utf8"),
);
assert.match(
  runtime.targets[target] ?? "",
  /^[0-9a-f]{64}$/,
  "Unpinned Node target",
);
const windows = process.platform === "win32";
const tar = windows
  ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";
const nodePlatform = windows ? "win" : process.platform;
const nodeName = `node-v${runtime.version}-${nodePlatform}-${process.arch}`;
const nodeArchive = `${nodeName}.${windows ? "zip" : "tar.gz"}`;
const nodeUrl = `https://nodejs.org/download/release/v${runtime.version}/${nodeArchive}`;
const genericName = `${pkg.name}-${pkg.version}.tar.gz`;
const generic = join(resolve(values.input), genericName);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  (await readFile(join(resolve(values.input), "SHA256SUMS"), "utf8")).trim(),
  `${sha256(await readFile(generic))}  ${genericName}`,
  "Compiled package checksum mismatch",
);

const temporary = await mkdtemp(join(tmpdir(), "providers-standalone-"));
const name = `${pkg.name}-${pkg.version}-${target}`;
const root = join(temporary, name);
const output = resolve(values.output);
try {
  await mkdir(root);
  // npm's Unix-only .bin links are unnecessary: the launcher uses the CLI directly.
  execFileSync(tar, [
    "-xf",
    generic,
    "-C",
    root,
    "--strip-components=1",
    "--exclude=*/node_modules/.bin",
  ]);
  const metadata = JSON.parse(
    await readFile(join(root, "release.json"), "utf8"),
  );
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.sourceRevision, values.revision);
  const download = join(temporary, nodeArchive);
  execFileSync(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--max-time",
      "300",
      "--output",
      download,
      nodeUrl,
    ],
    { stdio: "inherit" },
  );
  assert.equal(
    sha256(await readFile(download)),
    runtime.targets[target],
    "Official Node archive checksum mismatch",
  );
  const binary = windows ? "node.exe" : "bin/node";
  execFileSync(tar, [
    "-xf",
    download,
    "-C",
    temporary,
    `${nodeName}/${binary}`,
    `${nodeName}/LICENSE`,
  ]);
  await mkdir(join(root, "runtime"));
  const node = windows ? "node.exe" : "node";
  await cp(join(temporary, nodeName, binary), join(root, "runtime", node));
  await cp(
    join(temporary, nodeName, "LICENSE"),
    join(root, "runtime", "LICENSE"),
  );
  if (windows) {
    await writeFile(
      join(root, "codex-desktop-providers.cmd"),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\cli.js" %*\r\nexit /b %errorlevel%\r\n',
    );
  } else {
    await chmod(join(root, "runtime", node), 0o755);
    await writeFile(
      join(root, "codex-desktop-providers"),
      '#!/bin/sh\nset -eu\ncase "$0" in\n  */*) base=${0%/*} ;;\n  *) base=. ;;\nesac\nbase=$(CDPATH= cd -- "$base" && pwd)\nexec "$base/runtime/node" "$base/dist/cli.js" "$@"\n',
      { mode: 0o755 },
    );
  }
  metadata.runtime = {
    name: "node",
    version: runtime.version,
    target,
    url: nodeUrl,
    sha256: runtime.targets[target],
  };
  await writeFile(
    join(root, "release.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  await mkdir(output, { recursive: true });
  const filename = `${name}.${windows ? "zip" : "tar.gz"}`;
  const archive = join(output, filename);
  if (windows) {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Compress-Archive -LiteralPath $env:STANDALONE_ROOT -DestinationPath $env:STANDALONE_ARCHIVE -CompressionLevel Optimal -Force",
      ],
      {
        env: {
          ...process.env,
          STANDALONE_ROOT: root,
          STANDALONE_ARCHIVE: archive,
        },
        stdio: "inherit",
      },
    );
  } else {
    execFileSync(tar, ["-czf", archive, "-C", temporary, name]);
  }
  await writeFile(
    join(output, `SHA256SUMS.${target}`),
    `${sha256(await readFile(archive))}  ${filename}\n`,
  );
  console.log(`Built ${archive} with Node ${runtime.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
