// Keep package metadata, the patch manifest, and the selected desktop adapter
// consistent before an archive is allowed to leave CI.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ADAPTERS, PATCH_VERSION } from "../dist/patch/adapters.js";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const pkg = await readJson("../package.json");
const lock = await readJson("../package-lock.json");
const compatibility = await readJson("../src/patch/compatibility.json");
assert.equal(PATCH_VERSION, pkg.version, "Patch and npm versions must match");
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.deepEqual(ADAPTERS, compatibility.adapters);
assert.ok(
  ADAPTERS.some(({ version }) => version === compatibility.desktop.version),
);
assert.ok(compatibility.desktop.url.includes(compatibility.desktop.version));
assert.match(compatibility.desktop.hash, /^sha256-[A-Za-z0-9+/]{43}=$/);
console.log(
  `Versions consistent: patch ${pkg.version}, desktop ${compatibility.desktop.version}`,
);
