import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { object, type JsonObject } from "./types.js";

const PREFIX = "[desktop-providers]";
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function fail(message: string): never {
  throw new Error(`${PREFIX} ${message}`);
}

function modelEntries(value: unknown, label: string): JsonObject[] {
  const entries = object(value)?.models;
  if (!Array.isArray(entries)) fail(`${label} must contain a models array`);
  const ids = new Set<string>();
  return entries.map((value) => {
    const entry = object(value);
    if (
      typeof entry?.slug !== "string" ||
      !entry.slug.trim() ||
      entry.slug !== entry.slug.trim()
    )
      fail(`${label} models need exact non-empty slugs`);
    if (ids.has(entry.slug))
      fail(`${label} contains duplicate model ${entry.slug}`);
    ids.add(entry.slug);
    return entry;
  });
}

/** Recursive object overrides; arrays replace and explicit null/false/empty
 * values remain meaningful. Never modify either source object. */
function overlay(base: JsonObject, overrides: JsonObject): JsonObject {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`Invalid override key ${key}`);
    const nested = object(value);
    result[key] = nested
      ? overlay(object(base[key]) ?? {}, nested)
      : structuredClone(value);
  }
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail(`${label} must be a positive safe integer`);
  return value;
}

function validateExternal(model: JsonObject): void {
  const label = String(model.slug);
  if (typeof model.display_name !== "string" || !model.display_name.trim())
    fail(`Model ${label} needs display_name`);
  const window = positiveInteger(
    model.context_window,
    `${label}.context_window`,
  );
  if (
    model.max_context_window != null &&
    positiveInteger(model.max_context_window, `${label}.max_context_window`) <
      window
  )
    fail(`Model ${label} has context_window above max_context_window`);
  if (model.auto_compact_token_limit != null)
    positiveInteger(
      model.auto_compact_token_limit,
      `${label}.auto_compact_token_limit`,
    );
  if (
    model.effective_context_window_percent != null &&
    positiveInteger(
      model.effective_context_window_percent,
      `${label}.effective_context_window_percent`,
    ) > 100
  )
    fail(`Model ${label} has effective_context_window_percent above 100`);
  const efforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((entry) => object(entry)?.effort)
    : [];
  if (
    !efforts.length ||
    efforts.some(
      (effort) => typeof effort !== "string" || !EFFORTS.has(effort),
    ) ||
    new Set(efforts).size !== efforts.length ||
    !efforts.includes(model.default_reasoning_level)
  )
    fail(
      `Model ${label} needs valid supported_reasoning_levels and an included default_reasoning_level`,
    );
  const instructions =
    object(model.model_messages)?.instructions_template ??
    model.base_instructions;
  if (typeof instructions !== "string")
    fail(`Model ${label} needs native model instructions`);
}

export interface ComposedCatalog {
  models: JsonObject[];
}

/** Official entries pass through unchanged. Only external entries inherit a
 * named native template. Cache identity/account metadata is never serialized. */
export function composeCatalog(
  native: unknown,
  external: unknown,
): ComposedCatalog {
  const nativeModels = modelEntries(native, "Native catalog");
  const specification = object(external);
  if (
    !specification ||
    Object.keys(specification).some(
      (key) => !["template", "models"].includes(key),
    )
  )
    fail("External catalog accepts only template and models");
  const template = specification.template;
  if (typeof template !== "string" || !template.trim())
    fail("External catalog needs an explicit template model ID");
  const source = nativeModels.find((model) => model.slug === template);
  if (!source)
    fail(
      `Native catalog is missing template ${template}; refresh its native cache before launching`,
    );
  const overrides = modelEntries(external, "External catalog");
  const nativeIds = new Set(nativeModels.map((model) => model.slug));
  const additions = overrides.map((entry) => {
    if (nativeIds.has(entry.slug))
      fail(
        `External model ${entry.slug} collides with a native model; official entries cannot be overridden`,
      );
    if (typeof entry.display_name !== "string" || !entry.display_name.trim())
      fail(`External model ${entry.slug} needs its own display_name`);
    for (const field of [
      "model_provider",
      "provider",
      "auth",
      "env_key",
      "base_url",
    ])
      if (Object.hasOwn(entry, field))
        fail(
          `Keep ${field} in native model_providers/profiles, not the external catalog`,
        );
    const model = overlay(source, entry);
    validateExternal(model);
    return model;
  });
  return { models: [...structuredClone(nativeModels), ...additions] };
}

interface Snapshot {
  path: string;
  text: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

async function readSnapshot(path: string): Promise<Snapshot> {
  const canonical = await realpath(path);
  if (basename(canonical) === "auth.json")
    fail("Credential files are not model catalogs");
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CATALOG_BYTES)
      fail("Catalog inputs must be regular files smaller than 64 MiB");
    const text = await file.readFile("utf8");
    return {
      path: canonical,
      text,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await file.close();
  }
}

function parseSnapshot(snapshot: Snapshot, label: string): unknown {
  try {
    return JSON.parse(snapshot.text);
  } catch {
    return fail(`${label} contains invalid JSON`);
  }
}

async function unchanged(snapshot: Snapshot): Promise<void> {
  const current = await lstat(snapshot.path);
  if (
    current.dev !== snapshot.dev ||
    current.ino !== snapshot.ino ||
    current.size !== snapshot.size ||
    current.mtimeMs !== snapshot.mtimeMs
  )
    fail("Catalog source changed during generation; retry before launching");
}

/** Host-side startup preparation. Not imported into the renderer, and performs
 * no HTTP requests, config writes, credential reads, or helper execution. */
export async function prepareCatalog(
  nativePath: string,
  externalPath: string,
  outputPath: string,
): Promise<{
  nativeModels: number;
  externalModels: number;
  template: string;
  output: string;
}> {
  const [native, external] = await Promise.all([
    readSnapshot(nativePath),
    readSnapshot(externalPath),
  ]);
  await mkdir(dirname(resolve(outputPath)), { recursive: true, mode: 0o700 });
  const output = resolve(
    await realpath(dirname(resolve(outputPath))),
    basename(outputPath),
  );
  if (
    [native.path, external.path].includes(output) ||
    basename(output) === "auth.json"
  )
    fail(
      "Generated catalog must be separate from its source and credential files",
    );
  let existing;
  try {
    existing = await lstat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && !existing.isFile())
    fail("Generated catalog target must be a regular file, not a link");
  if (
    existing &&
    [native, external].some(
      (source) => source.dev === existing.dev && source.ino === existing.ino,
    )
  )
    fail("Generated catalog must not alias a source file");
  const parsedExternal = parseSnapshot(external, "External catalog");
  const catalog = composeCatalog(
    parseSnapshot(native, "Native catalog"),
    parsedExternal,
  );
  const temporary = `${output}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(catalog, null, 2) + "\n");
    await file.sync();
    await file.close();
    await unchanged(native);
    await unchanged(external);
    await rename(temporary, output);
    // Node cannot fsync directory handles on Windows. The temporary file is
    // flushed above and renamed within the same directory on every platform.
    if (process.platform !== "win32") {
      const directory = await open(dirname(output), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const count = (object(parsedExternal)!.models as unknown[]).length;
  return {
    nativeModels: catalog.models.length - count,
    externalModels: count,
    template: String(object(parsedExternal)!.template),
    output,
  };
}

export async function launchApplication(
  executable: string,
  args: string[],
): Promise<number> {
  const child = spawn(executable, args, { stdio: "inherit" });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
