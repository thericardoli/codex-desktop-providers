#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { applyPatch, planPatch } from "./patch/patch.js";
import { launchApplication, prepareCatalog } from "./runtime/catalog.js";

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
      "Usage:\n  codex-desktop-providers <check|patch> --asar /path/to/app.asar\n  codex-desktop-providers catalog --native-cache PATH --external PATH --output PATH\n  codex-desktop-providers launch --native-cache PATH --external PATH --output PATH --app EXECUTABLE -- [app arguments]\n\ncheck/patch discover and atomically patch matching Desktop assets.\ncatalog merges unchanged native entries with external overrides inheriting a native template.\nlaunch prepares the catalog before starting the specified app; generation failure prevents launch.\nNo command reads credentials, invokes credential helpers, or changes native config/history.",
    );
    return;
  }
  const command = positionals[0];
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
    !values.asar
  ) {
    throw new Error(
      "Expected check|patch and --asar PATH; use --help for usage",
    );
  }
  const runtime = fileURLToPath(new URL("./runtime", import.meta.url));
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
