import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MANIFEST_PATH,
  PATCH_VERSION,
  RUNTIME_DIRECTORY,
  RUNTIME_ASSETS,
} from "./constants.js";
import { hasEntry, readText, rewriteArchive, sha256 } from "./archive.js";
import { discoverChanges, isRendererAsset } from "./discovery.js";
import { PATCH_POINTS } from "./transforms.js";

interface Manifest {
  schemaVersion: 2;
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

/** Validate our installed patch, without comparing against an upstream allowlist. */
function verifyManifest(
  value: unknown,
  runtimeAssets: ReadonlyMap<string, Buffer>,
): Manifest {
  const manifest = value as Partial<Manifest> | null;
  const validHashes = (hashes: unknown): hashes is Record<string, string> =>
    hashes != null &&
    typeof hashes === "object" &&
    !Array.isArray(hashes) &&
    Object.values(hashes).every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    );
  if (
    !manifest ||
    manifest.schemaVersion !== 2 ||
    manifest.patchVersion !== PATCH_VERSION ||
    typeof manifest.appVersion !== "string" ||
    !validHashes(manifest.inputs) ||
    !validHashes(manifest.outputs)
  )
    throw new Error(
      "Archive contains a different or invalid patch; rebuild from the clean upstream package",
    );
  const sourcePaths = Object.keys(manifest.inputs);
  const expectedPaths = [...sourcePaths, ...runtimeAssets.keys()].sort();
  if (
    !sourcePaths.length ||
    sourcePaths.length > PATCH_POINTS.length ||
    !sourcePaths.every(isRendererAsset) ||
    Object.keys(manifest.outputs).sort().join("\n") !==
      expectedPaths.join("\n") ||
    [...runtimeAssets].some(
      ([path, data]) => manifest.outputs![path] !== sha256(data),
    )
  )
    throw new Error(
      "Archive contains inconsistent patch assets; rebuild from the clean upstream package",
    );
  return manifest as Manifest;
}

export async function planPatch(
  archive: string,
  runtimeDirectory: string,
): Promise<PatchPlan> {
  const pkg: { version?: unknown } = hasEntry(archive, "package.json")
    ? JSON.parse(readText(archive, "package.json"))
    : {};
  const appVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  const runtimeAssets = new Map<string, Buffer>();
  for (const name of RUNTIME_ASSETS)
    runtimeAssets.set(
      `${RUNTIME_DIRECTORY}/${name}`,
      await readFile(join(runtimeDirectory, name)),
    );
  if (hasEntry(archive, MANIFEST_PATH)) {
    const manifest = verifyManifest(
      JSON.parse(readText(archive, MANIFEST_PATH)),
      runtimeAssets,
    );
    for (const [path, hash] of Object.entries(manifest.outputs)) {
      if (sha256(readText(archive, path)) !== hash)
        throw new Error(`Patched asset failed integrity verification: ${path}`);
    }
    return { status: "already-patched", manifest, changes: new Map() };
  }
  const inputs: Record<string, string> = {};
  const changes = new Map<string, Buffer>();
  for (const [path, { source, output }] of discoverChanges(archive)) {
    inputs[path] = sha256(source);
    changes.set(path, Buffer.from(output));
  }
  for (const [path, data] of runtimeAssets) {
    if (hasEntry(archive, path))
      throw new Error(
        `Runtime asset already exists without a patch manifest: ${path}`,
      );
    changes.set(path, data);
  }
  const manifest: Manifest = {
    schemaVersion: 2,
    patchVersion: PATCH_VERSION,
    appVersion,
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
