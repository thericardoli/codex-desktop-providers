import { posix } from "node:path";
import { listPackedFiles, readText } from "./archive.js";
import { RUNTIME_DIRECTORY } from "./constants.js";
import {
  PATCH_POINTS,
  applyEdits,
  findPatchEdits,
  isPatchCandidate,
  type PatchEdit,
} from "./transforms.js";

export function isRendererAsset(path: string): boolean {
  return (
    path.startsWith("webview/") &&
    /\.m?js$/.test(path) &&
    !path.startsWith(`${RUNTIME_DIRECTORY}/`)
  );
}

/** Asset names, source hashes, and Desktop version strings are not selectors. */
export function discoverChanges(
  archive: string,
): Map<string, { source: string; output: string }> {
  const assets: { path: string; source: string; edits: PatchEdit[] }[] = [];
  for (const path of listPackedFiles(archive).filter(isRendererAsset)) {
    const source = readText(archive, path);
    if (!isPatchCandidate(source)) continue;
    try {
      const edits = findPatchEdits(source);
      if (edits.length) assets.push({ path, source, edits });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot inspect renderer asset ${path}: ${detail}`, {
        cause: error,
      });
    }
  }
  for (const point of PATCH_POINTS) {
    const matches = assets.flatMap((asset) =>
      asset.edits.filter((edit) => edit.point === point).map(() => asset.path),
    );
    if (matches.length !== 1)
      throw new Error(
        `Expected exactly one ${point} patch point; found ${matches.length}${matches.length ? ` in ${matches.join(", ")}` : ""}`,
      );
  }
  const changes = new Map<string, { source: string; output: string }>();
  for (const { path, source, edits } of assets) {
    let runtimeImport = posix.relative(
      posix.dirname(path),
      `${RUNTIME_DIRECTORY}/index.js`,
    );
    if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
    changes.set(path, {
      source,
      output: applyEdits(source, edits, runtimeImport),
    });
  }
  return changes;
}
