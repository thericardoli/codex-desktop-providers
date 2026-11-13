#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { applyPatch, planPatch } from "./patch/patch.js";
import { launchApplication, prepareCatalog } from "./runtime/catalog.js";
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
    },
  });
  if (values.help) {
    console.log(
      "Usage:\n  codex-desktop-providers <check|patch> --asar /path/to/app.asar\n  codex-desktop-providers prepare-windows --app PATH_TO_EXE --output NEW_DIRECTORY\n  codex-desktop-providers catalog --native-cache PATH --external PATH --output PATH\n  codex-desktop-providers launch --native-cache PATH --external PATH --output PATH --app EXECUTABLE -- [app arguments]\n\ncheck validates archive structure only; ready does not certify write permissions or application startup.\npatch atomically patches a writable archive; WindowsApps installations cannot be patched in place.\nprepare-windows copies the full application to NEW_DIRECTORY/app, patches and verifies the copy, and synchronizes embedded ASAR integrity. It does not start or register the app.\ncatalog merges unchanged native entries with external overrides inheriting a native template.\nlaunch prepares the catalog before starting the specified app; generation failure prevents launch.\nNo command reads credentials, invokes credential helpers, or changes native config/history.",
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
      values.external
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
  if (command === "catalog" || command === "launch") {
    if (
      !values["native-cache"] ||
      !values.external ||
      !values.output ||
      values.asar ||
      (command === "catalog" && (positionals.length !== 1 || values.app)) ||
      (command === "launch" && !values.app)
    )
      throw new Error(
        "Expected native-cache, external, output, and (for launch) app; use --help",
      );
    const result = await prepareCatalog(
      values["native-cache"],
      values.external,
      values.output,
    );
    if (command === "catalog") console.log(JSON.stringify(result, null, 2));
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
    values.external
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
