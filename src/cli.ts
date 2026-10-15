#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { applyPatch, planPatch } from "./patch/patch.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      asar: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: codex-desktop-providers <check|patch> --asar /path/to/app.asar\n\ncheck validates compatibility without writing; patch atomically applies the reviewed adapter.\nBuild-time tool only: it does not start the app, change config, or access credentials.",
    );
    return;
  }
  const command = positionals[0];
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
