import { getRawHeader, extractFile, uncache } from "@electron/asar";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import { open, stat, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { archiveWriteError, assertPatchTarget } from "./target.js";

interface Entry {
  files?: Record<string, Entry>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
  link?: string;
  integrity?: {
    algorithm: string;
    hash: string;
    blockSize: number;
    blocks: string[];
  };
  [key: string]: unknown;
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function integrity(content: Buffer, blockSize = 4 * 1024 * 1024) {
  const blocks: string[] = [];
  for (let start = 0; start < content.length; start += blockSize) {
    blocks.push(sha256(content.subarray(start, start + blockSize)));
  }
  return { algorithm: "SHA256", hash: sha256(content), blockSize, blocks };
}

function entryAt(root: Entry, path: string, create = false): Entry {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid archive path");
  let entry = root;
  for (const part of parts) {
    if (!entry.files) {
      if (!create || entry.link || entry.offset)
        throw new Error(`Not an ASAR directory: ${path}`);
      entry.files = {};
    }
    if (!entry.files[part]) {
      if (!create) throw new Error(`Missing ASAR entry: ${path}`);
      entry.files[part] = {};
    }
    entry = entry.files[part]!;
  }
  return entry;
}

export function readText(archive: string, path: string): string {
  // Our ASAR paths use '/', while the independent reader splits on host separators.
  return extractFile(archive, path.replaceAll("/", sep)).toString("utf8");
}

export function hasEntry(archive: string, path: string): boolean {
  try {
    entryAt(getRawHeader(archive).header as Entry, path);
    return true;
  } catch {
    return false;
  }
}

/** Enumerate packed files without following links or reading unpacked resources. */
export function listPackedFiles(archive: string): string[] {
  const result: string[] = [];
  function visit(entry: Entry, prefix: string): void {
    if (entry.files) {
      for (const [name, child] of Object.entries(entry.files))
        visit(child, prefix ? `${prefix}/${name}` : name);
    } else if (!entry.link && !entry.unpacked) {
      result.push(prefix);
    }
  }
  visit(getRawHeader(archive).header as Entry, "");
  return result.sort();
}

/** Chromium Pickle framing used by Electron's documented ASAR format. */
function encodeHeader(header: Entry): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const paddedLength = (json.length + 3) & ~3;
  const result = Buffer.alloc(16 + paddedLength);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(8 + paddedLength, 4);
  result.writeUInt32LE(4 + paddedLength, 8);
  result.writeUInt32LE(json.length, 12);
  json.copy(result, 16);
  return result;
}

/**
 * Append-only payload rewrite: retain every original entry, unpacked flag,
 * symlink, executable bit and payload offset. Replace only reviewed assets.
 * This avoids extracting/repacking thousands of unrelated native dependencies.
 * The official ASAR reader verifies changed entries before the atomic rename.
 */
export async function rewriteArchive(
  archive: string,
  changes: ReadonlyMap<string, Buffer>,
): Promise<void> {
  await assertPatchTarget(archive);
  const original = await stat(archive);
  const raw = getRawHeader(archive);
  const header = structuredClone(raw.header) as Entry;
  const payloadStart = 8 + raw.headerSize;
  let offset = original.size - payloadStart;
  if (offset < 0) throw new Error("Invalid ASAR payload size");
  for (const [path, content] of changes) {
    const entry = entryAt(header, path, true);
    if (entry.files || entry.link || entry.unpacked)
      throw new Error(`Cannot replace non-packed asset: ${path}`);
    entry.size = content.length;
    entry.offset = String(offset);
    entry.integrity = integrity(content, entry.integrity?.blockSize);
    offset += content.length;
  }
  const temporary = await mkdtemp(
    join(dirname(archive), ".desktop-providers-"),
  ).catch((error: unknown) => archiveWriteError(error, archive));
  const output = join(temporary, basename(archive));
  try {
    await writeArchive(
      output,
      encodeHeader(header),
      archive,
      payloadStart,
      original,
      changes,
    );
    uncache(output);
    for (const [path, content] of changes) {
      if (!extractFile(output, path.replaceAll("/", sep)).equals(content))
        throw new Error(`ASAR verification failed: ${path}`);
    }
    // Detect a replaced/truncated source while the patch was being prepared.
    const current = await stat(archive);
    if (
      current.ino !== original.ino ||
      current.size !== original.size ||
      current.mtimeMs !== original.mtimeMs
    ) {
      throw new Error("Source archive changed during patching");
    }
    await rename(output, archive);
    uncache(archive);
  } catch (error) {
    archiveWriteError(error, archive);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeArchive(
  output: string,
  header: Buffer,
  source: string,
  payloadStart: number,
  metadata: Stats,
  changes: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const file = await open(output, "wx", metadata.mode & 0o777);
  try {
    await file.writeFile(header);
    // Use a separate descriptor so pipeline closing cannot close `file`.
    if (metadata.size > payloadStart) {
      await pipeline(
        createReadStream(source, { start: payloadStart }),
        createWriteStream(output, { flags: "a" }),
      );
    }
    let position = header.length + metadata.size - payloadStart;
    for (const content of changes.values()) {
      let written = 0;
      while (written < content.length) {
        const result = await file.write(
          content,
          written,
          content.length - written,
          position,
        );
        if (result.bytesWritten === 0)
          throw new Error("Could not append patched ASAR data");
        written += result.bytesWritten;
        position += result.bytesWritten;
      }
    }
    await file.sync();
  } finally {
    await file.close();
  }
}
