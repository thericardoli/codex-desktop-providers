import assert from "node:assert/strict";
import test from "node:test";
import {
  createPackageWithOptions,
  extractFile,
  statFile,
  uncache,
} from "@electron/asar";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteArchive, sha256 } from "../src/patch/archive.js";

test("rewrite ASAR atomically while retaining unpacked files, links, modes and unrelated bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-providers-test-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets", "edit.js"), "before");
    await writeFile(join(source, "keep.txt"), "untouched payload");
    await writeFile(join(source, "native.node"), "unpacked native fixture");
    await writeFile(join(source, "executable"), "executable payload");
    await chmod(join(source, "executable"), 0o755);
    await symlink("keep.txt", join(source, "link"));
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpack: "*.node" });
    const nativeBefore = await readFile(archive + ".unpacked/native.node");
    await rewriteArchive(
      archive,
      new Map([
        ["assets/edit.js", Buffer.from("after with a different length")],
        ["assets/new/runtime.js", Buffer.from("export const patched = true;")],
      ]),
    );
    uncache(archive);
    assert.equal(
      extractFile(archive, "assets/edit.js").toString(),
      "after with a different length",
    );
    assert.equal(
      extractFile(archive, "keep.txt").toString(),
      "untouched payload",
    );
    assert.equal(extractFile(archive, "link").toString(), "untouched payload");
    assert.equal(
      extractFile(archive, "assets/new/runtime.js").toString(),
      "export const patched = true;",
    );
    assert.equal(
      "executable" in statFile(archive, "executable") &&
        (statFile(archive, "executable") as { executable: boolean }).executable,
      true,
    );
    assert.equal(statFile(archive, "native.node").unpacked, true);
    assert.deepEqual(
      await readFile(archive + ".unpacked/native.node"),
      nativeBefore,
    );
    const changed = statFile(archive, "assets/edit.js") as {
      integrity: { hash: string };
    };
    assert.equal(
      changed.integrity.hash,
      sha256("after with a different length"),
    );
    const before = sha256(await readFile(archive));
    await assert.rejects(
      rewriteArchive(archive, new Map([["native.node", Buffer.from("bad")]])),
      /non-packed asset/,
    );
    assert.equal(sha256(await readFile(archive)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
