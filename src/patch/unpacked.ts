import { getRawHeader } from "@electron/asar";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

interface ArchiveEntry {
  files?: Record<string, ArchiveEntry>;
  unpacked?: boolean;
  size?: number;
}

export interface UnpackedFile {
  path: string;
  expectedSize: number;
  actual: { size: number; sha256: string } | null;
}

/** Capture the actual source payload, not an assumption about runtime requirements. */
export async function snapshotUnpackedFiles(
  archive: string,
): Promise<UnpackedFile[]> {
  const entries: { path: string; expectedSize: number }[] = [];
  function visit(entry: ArchiveEntry, path: string): void {
    if (entry.files) {
      for (const [name, child] of Object.entries(entry.files))
        visit(child, path ? `${path}/${name}` : name);
    } else if (entry.unpacked) {
      if (path.split("/").some((part) => part.toLowerCase() === "auth.json"))
        throw new Error(
          "Unpacked application entry names auth.json; select application files only",
        );
      entries.push({ path, expectedSize: entry.size! });
    }
  }
  visit(getRawHeader(archive).header as ArchiveEntry, "");
  const result: UnpackedFile[] = [];
  for (const entry of entries) {
    const path = join(archive + ".unpacked", ...entry.path.split("/"));
    const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new Error(
        `Cannot read unpacked application file ${entry.path}: ${error.message}`,
        { cause: error },
      );
    });
    if (!file) {
      result.push({ ...entry, actual: null });
      continue;
    }
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw new Error(
          `Unpacked application entry is not a regular file: ${entry.path}`,
        );
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error(
          `Unpacked application file changed while reading: ${entry.path}`,
        );
      result.push({
        ...entry,
        actual: { size: after.size, sha256: hash.digest("hex") },
      });
    } finally {
      await file.close();
    }
  }
  return result;
}

/** A missing source entry may stay missing; existing bytes must survive copying. */
export async function verifyUnpackedCopy(
  archive: string,
  source: UnpackedFile[],
): Promise<void> {
  const copied = await snapshotUnpackedFiles(archive);
  if (copied.length !== source.length)
    throw new Error("Prepared archive changed the unpacked file inventory");
  for (let index = 0; index < source.length; index++) {
    const before = source[index]!;
    const after = copied[index]!;
    if (
      before.path !== after.path ||
      before.expectedSize !== after.expectedSize ||
      before.actual?.size !== after.actual?.size ||
      before.actual?.sha256 !== after.actual?.sha256
    )
      throw new Error(
        `Prepared unpacked file differs from source: ${before.path}`,
      );
  }
}

export function unpackedSourceIssues(files: UnpackedFile[]) {
  return files.flatMap((file) => {
    if (file.actual && file.actual.size === file.expectedSize) return [];
    return [
      {
        path: file.path,
        issue: file.actual ? "size-mismatch" : "missing",
        expectedSize: file.expectedSize,
        actualSize: file.actual?.size ?? null,
      },
    ];
  });
}
