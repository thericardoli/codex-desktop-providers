import { realpath } from "node:fs/promises";

/** Recognize standard package volumes, including extended-length Windows paths. */
export function isWindowsAppsPath(path: string): boolean {
  const normalized = path.replaceAll("/", "\\").replace(/^\\\\\?\\/, "");
  return /^[a-z]:\\(?:Program Files\\)?WindowsApps(?:\\|$)/i.test(normalized);
}

export async function inspectPatchTarget(archive: string) {
  const path = await realpath(archive);
  return {
    path,
    inPlacePatch: isWindowsAppsPath(path)
      ? "unsupported-windowsapps"
      : "permissions-not-checked",
  };
}

export async function assertPatchTarget(archive: string): Promise<void> {
  if (
    (await inspectPatchTarget(archive)).inPlacePatch ===
    "unsupported-windowsapps"
  )
    throw new Error(
      "Cannot patch a protected WindowsApps installation in place. Use prepare-windows --app PATH_TO_EXE --output NEW_DIRECTORY to create a patched application copy in a user-writable directory. check only validates archive structure; administrator elevation does not make this a supported patch target.",
    );
}

export function archiveWriteError(error: unknown, archive: string): never {
  if (
    ["EACCES", "EPERM", "EROFS"].includes(
      (error as NodeJS.ErrnoException)?.code ?? "",
    )
  )
    throw new Error(
      `Cannot write or replace the archive at ${archive}. The archive and its parent directory must be writable. On Windows, use prepare-windows --app PATH_TO_EXE --output NEW_DIRECTORY. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  throw error;
}
