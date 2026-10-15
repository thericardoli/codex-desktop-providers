// Validate the tool's own version metadata; Desktop versions are unrestricted.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PATCH_VERSION } from "../dist/patch/constants.js";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const pkg = await readJson("../package.json");
const lock = await readJson("../package-lock.json");
assert.equal(PATCH_VERSION, pkg.version, "Patch and npm versions must match");
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
console.log(`Tool version consistent: ${pkg.version}`);
