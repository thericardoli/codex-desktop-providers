import assert from "node:assert/strict";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPatch } from "../src/patch/patch.js";
import { ADAPTERS } from "../src/patch/adapters.js";
import { sha256 } from "../src/patch/archive.js";

test("unsupported versions and same-version asset drift fail without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-providers-plan-"));
  const runtime = fileURLToPath(new URL("../src/runtime", import.meta.url));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ version: "unsupported" }),
    );
    const unsupported = join(root, "unsupported.asar");
    await createPackage(source, unsupported);
    const hash = sha256(await readFile(unsupported));
    await assert.rejects(
      planPatch(unsupported, runtime),
      /Unsupported desktop version/,
    );
    assert.equal(sha256(await readFile(unsupported)), hash);

    const adapter = ADAPTERS[0]!;
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ version: adapter.version }),
    );
    const asset = join(source, adapter.shared.path);
    await mkdir(join(source, "webview/assets"), { recursive: true });
    await writeFile(asset, "export const unexpectedBuild = true;");
    const drift = join(root, "drift.asar");
    await createPackage(source, drift);
    const before = sha256(await readFile(drift));
    await assert.rejects(planPatch(drift, runtime), /fingerprint mismatch/);
    assert.equal(sha256(await readFile(drift)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
