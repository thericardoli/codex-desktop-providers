import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTERS,
  MANIFEST_PATH,
  PATCH_VERSION,
  RUNTIME_DIRECTORY,
  RUNTIME_ASSETS,
} from "./adapters.js";
import { hasEntry, readText, rewriteArchive, sha256 } from "./archive.js";
import { transformPicker, transformShared } from "./transforms.js";

interface Manifest {
  schemaVersion: 1;
  patchVersion: string;
  appVersion: string;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
}

export interface PatchPlan {
  status: "ready" | "already-patched";
  manifest: Manifest;
  changes: Map<string, Buffer>;
}

export async function planPatch(
  archive: string,
  runtimeDirectory: string,
): Promise<PatchPlan> {
  const pkg = JSON.parse(readText(archive, "package.json")) as {
    version: string;
  };
  const adapter = ADAPTERS.find(
    (candidate) => candidate.version === pkg.version,
  );
  if (!adapter)
    throw new Error(
      `Unsupported desktop version: ${pkg.version}. Add and review a version adapter first`,
    );
  const runtimeAssets = new Map<string, Buffer>();
  for (const name of RUNTIME_ASSETS)
    runtimeAssets.set(
      `${RUNTIME_DIRECTORY}/${name}`,
      await readFile(join(runtimeDirectory, name)),
    );
  if (hasEntry(archive, MANIFEST_PATH)) {
    const manifest = JSON.parse(readText(archive, MANIFEST_PATH)) as Manifest;
    const expectedPaths = [
      adapter.shared.path,
      adapter.picker.path,
      ...runtimeAssets.keys(),
    ].sort();
    if (
      !manifest ||
      manifest.schemaVersion !== 1 ||
      manifest.patchVersion !== PATCH_VERSION ||
      manifest.appVersion !== pkg.version ||
      !manifest.outputs ||
      !manifest.inputs ||
      Object.keys(manifest.outputs).sort().join("\n") !==
        expectedPaths.join("\n") ||
      manifest.inputs[adapter.shared.path] !== adapter.shared.sha256 ||
      manifest.inputs[adapter.picker.path] !== adapter.picker.sha256 ||
      [...runtimeAssets].some(
        ([path, data]) => manifest.outputs[path] !== sha256(data),
      )
    ) {
      throw new Error(
        "Archive contains a different patch; rebuild from the clean upstream package",
      );
    }
    for (const [path, hash] of Object.entries(manifest.outputs)) {
      if (sha256(readText(archive, path)) !== hash)
        throw new Error(`Patched asset failed integrity verification: ${path}`);
    }
    return { status: "already-patched", manifest, changes: new Map() };
  }
  const inputs: Record<string, string> = {};
  const changes = new Map<string, Buffer>();
  for (const [asset, transform] of [
    [adapter.shared, transformShared],
    [adapter.picker, transformPicker],
  ] as const) {
    const source = readText(archive, asset.path);
    const hash = sha256(source);
    if (hash !== asset.sha256)
      throw new Error(
        `Upstream asset fingerprint mismatch: ${asset.path}. Expected ${asset.sha256}, got ${hash}`,
      );
    inputs[asset.path] = hash;
    changes.set(asset.path, Buffer.from(transform(source)));
  }
  for (const [path, data] of runtimeAssets) {
    if (hasEntry(archive, path))
      throw new Error(
        `Runtime asset already exists without a patch manifest: ${path}`,
      );
    changes.set(path, data);
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    patchVersion: PATCH_VERSION,
    appVersion: pkg.version,
    inputs,
    outputs: Object.fromEntries(
      [...changes].map(([path, data]) => [path, sha256(data)]),
    ),
  };
  changes.set(
    MANIFEST_PATH,
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
  );
  return { status: "ready", manifest, changes };
}

export async function applyPatch(
  archive: string,
  plan: PatchPlan,
): Promise<void> {
  if (plan.status === "already-patched") return;
  await rewriteArchive(archive, plan.changes);
}
