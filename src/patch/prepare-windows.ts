import { getRawHeader, uncache } from "@electron/asar";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { sha256 } from "./archive.js";
import { applyPatch, planPatch } from "./patch.js";
import { isWindowsAppsPath } from "./target.js";
import {
  snapshotUnpackedFiles,
  unpackedSourceIssues,
  verifyUnpackedCopy,
} from "./unpacked.js";
import {
  inspectWindowsIntegrity,
  updateWindowsIntegrity,
} from "./windows-executable.js";

function within(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

interface Entry {
  path: string;
  type: "directory" | "file" | "link";
  mode: number;
  identity: string;
  link?: string;
  directoryLink?: boolean;
}

/** Inventory before writing, without following links or reading credential files. */
async function inventory(root: string): Promise<Entry[]> {
  const result: Entry[] = [];
  async function visit(path: string): Promise<void> {
    if (basename(path).toLowerCase() === "auth.json")
      throw new Error(
        "Application directory contains auth.json; select application files only, not a user-data directory",
      );
    const full = join(root, path);
    const info = await lstat(full);
    const entry: Entry = {
      path,
      type: info.isDirectory()
        ? "directory"
        : info.isSymbolicLink()
          ? "link"
          : "file",
      mode: info.mode & 0o777,
      identity: [
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        info.mode,
      ].join(":"),
    };
    if (entry.type === "link") {
      const link = await readlink(full);
      const lexical = resolve(dirname(full), link);
      const actual = await realpath(full);
      if (!within(root, lexical) || !within(root, actual))
        throw new Error(`Application link escapes its directory: ${path}`);
      // Absolute internal links must point into the copy, never back at WindowsApps.
      entry.link = isAbsolute(link)
        ? relative(dirname(full), lexical) || "."
        : link;
      entry.directoryLink = (await stat(full)).isDirectory();
    } else if (!info.isDirectory() && !info.isFile()) {
      throw new Error(`Unsupported application file type: ${path}`);
    }
    result.push(entry);
    if (entry.type === "directory")
      for (const child of (await readdir(full)).sort())
        await visit(join(path, child));
  }
  await visit("");
  return result;
}

async function copyApplication(
  source: string,
  destination: string,
  entries: Entry[],
) {
  for (const entry of entries.filter((entry) => entry.type !== "link")) {
    const target = join(destination, entry.path);
    if (entry.type === "directory") {
      await mkdir(target, { mode: entry.mode | 0o700 });
    } else {
      await copyFile(join(source, entry.path), target, constants.COPYFILE_EXCL);
      await chmod(target, entry.mode);
    }
  }
  for (const entry of entries.filter((entry) => entry.type === "link"))
    await symlink(
      entry.link!,
      join(destination, entry.path),
      entry.directoryLink ? "dir" : "file",
    );
}

function headerHash(archive: string): string {
  uncache(archive);
  return sha256(getRawHeader(archive).headerString);
}

/**
 * Build a self-contained application copy. Only the explicitly selected app's
 * directory is read; no package registration, credentials or user state migrate.
 * A fresh private output directory reserves ownership for failure cleanup.
 */
export async function prepareWindows(
  app: string,
  output: string,
  runtime: string,
) {
  const requestedApp = resolve(app);
  const source = await realpath(dirname(requestedApp));
  const executableName = basename(requestedApp);
  const executable = join(source, executableName);
  const archive = join(source, "resources", "app.asar");
  if (
    !executableName.toLowerCase().endsWith(".exe") ||
    !(await lstat(executable)).isFile()
  )
    throw new Error(
      "--app must name a Windows application EXE beside resources/app.asar",
    );
  if (!(await lstat(archive)).isFile() || (await realpath(archive)) !== archive)
    throw new Error(
      "resources/app.asar must be a regular file inside the application directory",
    );

  // Canonicalize the nearest existing output ancestor, even for nested new paths.
  const requestedOutput = resolve(output);
  let ancestor = requestedOutput;
  const missing: string[] = [];
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (
        await lstat(ancestor).then(
          () => true,
          (failure: NodeJS.ErrnoException) => {
            if (failure.code !== "ENOENT") throw failure;
            return false;
          },
        )
      )
        throw new Error("Output contains a dangling link");
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const destination = join(ancestor, ...missing);
  if (!missing.length)
    throw new Error(
      "Output already exists; choose a new directory for each prepared application",
    );
  if (within(source, destination) || within(destination, source))
    throw new Error(
      "Output must be separate from the source application directory",
    );
  if (isWindowsAppsPath(destination))
    throw new Error(
      "Output must be outside WindowsApps, in a user-writable directory",
    );

  const before = await inventory(source);
  const plan = await planPatch(archive, runtime);
  const originalHeader = headerHash(archive);
  const unpacked = await snapshotUnpackedFiles(archive);
  const sourceUnpackedIssues = unpackedSourceIssues(unpacked);
  const binary = await readFile(executable);
  inspectWindowsIntegrity(binary, originalHeader);

  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 }); // exclusive; never clean up an existing directory
  const staging = join(destination, ".preparing");
  try {
    await copyApplication(source, staging, before);
    if (JSON.stringify(await inventory(source)) !== JSON.stringify(before))
      throw new Error(
        "Source application changed during copying; close the app/updater and retry",
      );
    const copiedArchive = join(staging, "resources", "app.asar");
    const copiedExecutable = join(staging, executableName);
    if (
      headerHash(copiedArchive) !== originalHeader ||
      !(await readFile(copiedExecutable)).equals(binary)
    )
      throw new Error("Copied application does not match the inspected source");
    const copiedPlan = await planPatch(copiedArchive, runtime);
    if (JSON.stringify(copiedPlan.manifest) !== JSON.stringify(plan.manifest))
      throw new Error("Copied archive does not match the inspected patch plan");
    await chmod(copiedArchive, (await stat(copiedArchive)).mode | 0o200);
    await applyPatch(copiedArchive, copiedPlan);
    const updated = updateWindowsIntegrity(
      binary,
      originalHeader,
      headerHash(copiedArchive),
    );
    if (updated.modified) {
      await chmod(
        copiedExecutable,
        (await stat(copiedExecutable)).mode | 0o200,
      );
      const file = await open(copiedExecutable, "r+");
      try {
        await file.writeFile(updated.binary);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    if (!(await readFile(copiedExecutable)).equals(updated.binary))
      throw new Error("Prepared executable verification failed");
    const verified = await planPatch(copiedArchive, runtime);
    if (verified.status !== "already-patched")
      throw new Error("Prepared archive verification failed");
    await verifyUnpackedCopy(copiedArchive, unpacked);
    if (JSON.stringify(await inventory(source)) !== JSON.stringify(before))
      throw new Error(
        "Source application changed during preparation; retry with a stable source",
      );
    const application = join(destination, "app");
    await rename(staging, application);
    return {
      status: "prepared",
      app: join(application, executableName),
      asar: join(application, "resources", "app.asar"),
      ...verified.manifest,
      executableModified: updated.modified,
      embeddedAsarIntegrity: updated.enabled ? "enabled" : "disabled",
      authenticode:
        updated.modified && updated.signed
          ? "invalidated-in-copy"
          : "unchanged",
      runtimeValidation: "not-performed",
      sourceUnpackedIssues,
      notes: [
        "Start the returned app path after fully quitting the installed application. Store shortcuts still launch the installed copy.",
        "This copy is not registered as an MSIX package. Package-identity-dependent features and native login must be tested on Windows.",
        ...(sourceUnpackedIssues.length
          ? [
              `${sourceUnpackedIssues.length} unpacked entries already differ from the source ASAR metadata; see sourceUnpackedIssues. The copy preserves the source state. Startup and affected functionality have not been verified.`,
            ]
          : []),
        ...(updated.modified && updated.signed
          ? [
              "Updating the embedded ASAR digest invalidates this copy's publisher signature; Windows policies requiring signed executables may block it.",
            ]
          : []),
      ],
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
