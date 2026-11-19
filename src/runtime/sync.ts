import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  MAX_CATALOG_BYTES,
  modelEntries,
  parseSnapshot,
  publishCatalog,
  readSnapshot,
  type PreparedCatalog,
  type Snapshot,
} from "./catalog.js";
import type { JsonObject } from "./types.js";

const execute = promisify(execFile);

export interface NativeCatalogCommand {
  executable: string;
  args?: string[];
}

export interface SynchronizedCatalog extends PreparedCatalog {
  sync: {
    source: "cache" | "bundled" | "cache+bundled";
    addedModels: number;
    warnings: string[];
  };
}

/** --bundled bypasses model_catalog_json and does not authenticate or refresh
 * the account cache. Never run plain `debug models`: it can echo our own static
 * catalog back to us, including external entries. No shell or credential helper. */
async function bundledCatalog(
  command: NativeCatalogCommand,
  timeoutMs: number,
): Promise<JsonObject[]> {
  let stdout: string;
  try {
    ({ stdout } = await execute(
      command.executable,
      [...(command.args ?? []), "debug", "models", "--bundled"],
      {
        encoding: "utf8",
        maxBuffer: MAX_CATALOG_BYTES,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    ));
  } catch {
    // Child stderr/error messages may contain arbitrary user-supplied output.
    throw new Error(
      "Native bundled catalog export failed or timed out; check --codex and support for `debug models --bundled`",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Native bundled catalog export contains invalid JSON");
  }
  let models: JsonObject[];
  try {
    models = modelEntries(value, "Native bundled catalog");
  } catch {
    throw new Error(
      "Native bundled catalog export contains invalid model metadata",
    );
  }
  if (!models.length) throw new Error("Native bundled catalog is empty");
  return models;
}

/** Account-cache entries win exact-ID collisions; bundled native metadata only
 * fills missing IDs. Official entries are never edited or given guessed fields. */
export async function synchronizeCatalog(
  nativePath: string,
  externalPath: string,
  outputPath: string,
  command: NativeCatalogCommand = { executable: "codex" },
  timeoutMs = 10_000,
): Promise<SynchronizedCatalog> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Native catalog timeout must be a positive safe integer");
  const warnings: string[] = [];
  // Credential-file paths and aliases must fail through the existing offline
  // reader/writer checks, even when the native cache is absent or corrupt.
  let snapshot: Snapshot | undefined;
  let cached: JsonObject[] | undefined;
  try {
    snapshot = await readSnapshot(nativePath);
    cached = modelEntries(
      parseSnapshot(snapshot, "Native cache"),
      "Native cache",
    );
    if (!cached.length) cached = undefined;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Credential files are not model catalogs")
    )
      throw error;
    warnings.push(
      "Native cache is unavailable or invalid; using bundled metadata if available",
    );
  }
  let bundled: JsonObject[] | undefined;
  try {
    bundled = await bundledCatalog(command, timeoutMs);
  } catch (error) {
    warnings.push(
      `${(error as Error).message}; falling back to the native cache`,
    );
  }
  if (!cached && !bundled)
    throw new Error(
      "[desktop-providers] No valid native cache or bundled catalog; previous output was not replaced",
    );
  const models = [...(cached ?? [])];
  const ids = new Set(models.map((model) => model.slug));
  for (const model of bundled ?? []) {
    if (ids.has(model.slug)) continue;
    models.push(model);
    ids.add(model.slug);
  }
  const external = await readSnapshot(externalPath);
  const result = await publishCatalog(
    { models },
    external,
    outputPath,
    nativePath,
    snapshot ? [snapshot] : [],
  );
  return {
    ...result,
    sync: {
      source: cached ? (bundled ? "cache+bundled" : "cache") : "bundled",
      addedModels: models.length - (cached?.length ?? 0),
      warnings,
    },
  };
}
