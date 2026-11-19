#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { applyPatch, planPatch } from "./patch/patch.js";
import { launchApplication, prepareCatalog } from "./runtime/catalog.js";
import { synchronizeCatalog } from "./runtime/sync.js";
import { prepareWindows } from "./patch/prepare-windows.js";
import { assertPatchTarget, inspectPatchTarget } from "./patch/target.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      asar: { type: "string" },
      help: { type: "boolean", short: "h" },
      "native-cache": { type: "string" },
      external: { type: "string" },
      output: { type: "string" },
      app: { type: "string" },
      codex: { type: "string" },
      "cache-only": { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage:\n  codex-desktop-providers <check|patch> --asar /path/to/app.asar\n  codex-desktop-providers prepare-windows --app PATH_TO_EXE --output NEW_DIRECTORY\n  codex-desktop-providers catalog --native-cache PATH --external PATH --output PATH\n  codex-desktop-providers sync --native-cache PATH --external PATH --output PATH [--codex EXECUTABLE]\n  codex-desktop-providers launch --native-cache PATH --external PATH --output PATH --app EXECUTABLE [--codex EXECUTABLE | --cache-only] -- [app arguments]\n\ncheck validates archive structure only; ready does not certify write permissions or application startup.\npatch atomically patches a writable archive; WindowsApps installations cannot be patched in place.\nprepare-windows copies the full application to NEW_DIRECTORY/app, patches and verifies the copy, and synchronizes embedded ASAR integrity. It does not start or register the app.\ncatalog composes existing cache metadata offline.\nsync fills missing native models from `codex debug models --bundled` (codex on PATH by default); cache entries win exact-ID collisions. Export failure falls back to a valid cache with a warning.\nlaunch synchronizes before starting the specified app; --cache-only uses offline composition. Invalid combined metadata prevents launch.\nNo command reads credentials, invokes credential helpers, fetches account catalogs, or changes native config/history/cache. Updating a running backend still requires a restart.",
    );
    return;
  }
  const command = positionals[0];
  const runtime = fileURLToPath(new URL("./runtime", import.meta.url));
  if (command === "prepare-windows") {
    if (
      positionals.length !== 1 ||
      !values.app ||
      !values.output ||
      values.asar ||
      values["native-cache"] ||
      values.external ||
      values.codex ||
      values["cache-only"]
    )
      throw new Error(
        "Expected prepare-windows --app PATH_TO_EXE --output NEW_DIRECTORY; use --help",
      );
    console.log(
      JSON.stringify(
        await prepareWindows(values.app, values.output, runtime),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "catalog" || command === "sync" || command === "launch") {
    if (
      !values["native-cache"] ||
      !values.external ||
      !values.output ||
      values.asar ||
      (command !== "launch" && (positionals.length !== 1 || values.app)) ||
      (command === "launch" && !values.app) ||
      (command === "catalog" && (values.codex || values["cache-only"])) ||
      (command === "sync" && values["cache-only"]) ||
      (values.codex && values["cache-only"])
    )
      throw new Error(
        "Expected native-cache, external, output, and (for launch) app; use --help",
      );
    const paths = [
      values["native-cache"],
      values.external,
      values.output,
    ] as const;
    let result;
    if (command === "catalog" || values["cache-only"])
      result = await prepareCatalog(...paths);
    else {
      result = await synchronizeCatalog(...paths, {
        executable: values.codex ?? "codex",
      });
      for (const warning of result.sync.warnings)
        console.error(`[desktop-providers] ${warning}`);
    }
    if (command !== "launch") console.log(JSON.stringify(result, null, 2));
    else {
      process.exitCode = await launchApplication(
        values.app!,
        positionals.slice(1),
      );
    }
    return;
  }
  if (
    positionals.length !== 1 ||
    !["check", "patch"].includes(command ?? "") ||
    !values.asar ||
    values.app ||
    values.output ||
    values["native-cache"] ||
    values.external ||
    values.codex ||
    values["cache-only"]
  ) {
    throw new Error(
      "Expected check|patch and --asar PATH; use --help for usage",
    );
  }
  if (command === "patch") await assertPatchTarget(values.asar);
  const plan = await planPatch(values.asar, runtime);
  if (command === "patch") await applyPatch(values.asar, plan);
  console.log(
    JSON.stringify(
      {
        status:
          command === "patch" && plan.status === "ready"
            ? "patched"
            : plan.status,
        ...plan.manifest,
        ...(command === "check"
          ? {
              checkScope: "archive-structure",
              target: await inspectPatchTarget(values.asar),
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Patch failed");
  process.exitCode = 1;
});
