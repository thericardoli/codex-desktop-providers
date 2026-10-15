// Publish a portable, already compiled tool and its Nix installer together.
// Nix consumers lock this whole archive, including its production dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
    output: { type: "string", default: "release" },
    tag: { type: "string" },
  },
});
if (!values.package || !/^[0-9a-f]{40}$/.test(values.revision ?? ""))
  throw new Error(
    "Expected --package INSTALLED_PACKAGE --revision FULL_COMMIT_SHA",
  );
const source = fileURLToPath(new URL("../", import.meta.url));
const installed = resolve(values.package);
const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
const { PATCH_VERSION } = await import(
  pathToFileURL(join(installed, "dist/patch/adapters.js"))
);
const sourcePackage = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
assert.equal(pkg.version, sourcePackage.version);
assert.equal(pkg.version, PATCH_VERSION);
if (values.tag)
  assert.equal(values.tag, `v${pkg.version}`, "Tag must match package version");
const compatibility = JSON.parse(
  await readFile(join(installed, "dist/patch/compatibility.json"), "utf8"),
);
const name = `codex-desktop-providers-${pkg.version}`;
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "desktop-providers-release-"));
const root = join(temporary, name);

// Store paths must not leak into a portable release. Keep internal symlinks,
// restore ordinary permissions, and replace Nix's patched Node shebangs.
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
      const text = data.toString();
      const normalized = text.replace(
        /^#!\/nix\/store\/[^\n]+\/bin\/node\n/,
        "#!/usr/bin/env node\n",
      );
      if (normalized === text)
        throw new Error(`Unexpected Nix shebang: ${path}`);
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
    "package.json",
    "README.md",
    "LICENSE",
  ])
    await cp(join(installed, path), join(root, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  for (const path of ["nix", "flake.nix", "flake.lock"])
    await cp(join(source, path), join(root, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  await writeFile(
    join(root, "release.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        version: pkg.version,
        sourceRevision: values.revision,
        desktopVersion: compatibility.desktop.version,
      },
      null,
      2,
    ) + "\n",
  );
  await makePortable(root);
  const filename = "codex-desktop-providers.tar.gz";
  const archive = join(output, filename);
  // GNU tar and gzip come from the pinned Nix development environment.
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
  await writeFile(archive, gzip);
  const hash = createHash("sha256").update(gzip).digest("hex");
  await writeFile(join(output, "SHA256SUMS"), `${hash}  ${filename}\n`);
  console.log(`${archive}\nsha256: ${hash}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
