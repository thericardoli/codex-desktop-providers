// Package the compiled Nix output with its runtime dependencies, without store paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    revision: { type: "string" },
    tag: { type: "string" },
    output: { type: "string", default: "release" },
  },
});
if (!values.package || !/^[0-9a-f]{40}$/.test(values.revision ?? ""))
  throw new Error(
    "Expected --package INSTALLED_PACKAGE --revision FULL_COMMIT_SHA",
  );

const installed = resolve(values.package);
const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
const source = fileURLToPath(new URL("../package.json", import.meta.url));
const sourcePackage = JSON.parse(await readFile(source, "utf8"));
const { PATCH_VERSION } = await import(
  pathToFileURL(join(installed, "dist/patch/constants.js"))
);
assert.equal(pkg.name, "codex-desktop-providers");
assert.equal(pkg.version, sourcePackage.version);
assert.equal(pkg.version, PATCH_VERSION);
if (values.tag)
  assert.equal(values.tag, `v${pkg.version}`, "Tag must match package version");

const name = `${pkg.name}-${pkg.version}`;
const output = resolve(values.output);
const temporary = await mkdtemp(join(tmpdir(), "desktop-providers-release-"));
const root = join(temporary, name);

async function makePortable(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    const destination = relative(root, resolve(dirname(path), target));
    if (
      isAbsolute(target) ||
      destination === ".." ||
      destination.startsWith(`..${sep}`)
    )
      throw new Error(`Release contains an escaping symlink: ${path}`);
  } else if (stat.isDirectory()) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path))
      await makePortable(join(path, entry));
  } else if (stat.isFile()) {
    await chmod(path, stat.mode & 0o111 ? 0o755 : 0o644);
    let data = await readFile(path);
    if (data.subarray(0, 13).toString().startsWith("#!/nix/store/")) {
      const normalized = data
        .toString()
        .replace(
          /^#!\/nix\/store\/[^\n]+\/bin\/node\n/,
          "#!/usr/bin/env node\n",
        );
      data = Buffer.from(normalized);
      await writeFile(path, data);
    }
    if (data.includes(Buffer.from("/nix/store/")))
      throw new Error(`Release contains a Nix store reference: ${path}`);
  } else throw new Error(`Unsupported release entry: ${path}`);
}

try {
  await mkdir(root);
  for (const path of [
    "dist",
    "node_modules",
    "examples",
    "package.json",
    "README.md",
    "LICENSE",
  ])
    await cp(join(installed, path), join(root, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  await chmod(join(root, "dist/cli.js"), 0o755);
  await writeFile(
    join(root, "release.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        version: pkg.version,
        sourceRevision: values.revision,
      },
      null,
      2,
    ) + "\n",
  );
  await makePortable(root);
  const tar = execFileSync(
    "tar",
    [
      "--sort=name",
      "--mtime=@1",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-C",
      temporary,
      "-cf",
      "-",
      name,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const gzip = execFileSync("gzip", ["-n", "-9"], {
    input: tar,
    maxBuffer: 64 * 1024 * 1024,
  });
  const filename = `${name}.tar.gz`;
  const hash = createHash("sha256").update(gzip).digest("hex");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, filename), gzip);
  await writeFile(join(output, "SHA256SUMS"), `${hash}  ${filename}\n`);
  console.log(`${join(output, filename)}\nsha256: ${hash}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
