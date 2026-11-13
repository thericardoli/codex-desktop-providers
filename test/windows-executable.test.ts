import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectWindowsIntegrity,
  updateWindowsIntegrity,
} from "../src/patch/windows-executable.js";
import { windowsExecutable } from "./windows-fixtures.js";

const before = "a".repeat(64);
const after = "b".repeat(64);

for (const pe32 of [false, true]) {
  test(`synchronize PE${pe32 ? "32" : "32+"} ASAR digest without altering fuses or unrelated bytes`, () => {
    const binary = windowsExecutable(before, { pe32, signed: true });
    const original = Buffer.from(binary);
    const info = inspectWindowsIntegrity(binary, before);
    assert.equal(info.enabled, true);
    assert.equal(info.signed, true);
    const updated = updateWindowsIntegrity(binary, before, after);
    const expected = Buffer.from(original);
    expected.write(after, info.hashOffset!, 64, "ascii");
    assert.deepEqual(updated.binary, expected);
    assert.deepEqual(binary, original);
    assert.equal(updated.modified, true);
    assert.equal(inspectWindowsIntegrity(updated.binary, after).enabled, true);
    assert.equal(
      updateWindowsIntegrity(updated.binary, after, after).modified,
      false,
    );
    assert.throws(
      () => inspectWindowsIntegrity(updated.binary, before),
      /does not match/,
    );
  });
}

test("leave an executable without embedded integrity unchanged when its fuse is disabled", () => {
  const binary = windowsExecutable(before, { enabled: false, resource: false });
  const updated = updateWindowsIntegrity(binary, before, after);
  assert.equal(updated.enabled, false);
  assert.equal(updated.modified, false);
  assert.deepEqual(updated.binary, binary);
  assert.throws(
    () =>
      inspectWindowsIntegrity(
        windowsExecutable(before, { resource: false }),
        before,
      ),
    /expected one ELECTRONASAR/,
  );
});

test("retain a signed EXE with inactive integrity metadata byte-for-byte", () => {
  const binary = windowsExecutable(before, { enabled: false, signed: true });
  const updated = updateWindowsIntegrity(binary, before, after);
  assert.equal(updated.signed, true);
  assert.equal(updated.modified, false);
  assert.deepEqual(updated.binary, binary);
});

test("reject malformed, ambiguous, mismatched and unknown executable layouts", () => {
  const cases: [string, (binary: Buffer) => void, RegExp][] = [
    ["PE", (b) => b.fill(0, 0, 2), /PE executable/],
    [
      "resource offset",
      (b) => {
        b.writeUInt32LE(0x8000ffff, 0x214);
      },
      /resource offset/,
    ],
    [
      "resource data",
      (b) => {
        b.writeUInt32LE(0xfffffff0, 0x260);
      },
      /section mapping/,
    ],
    [
      "JSON",
      (b) => {
        b[0x300] = 0x78;
      },
      /malformed/,
    ],
    ["fuse absent", (b) => b.fill(0, 0xc00, 0xc20), /one Electron fuse/],
    [
      "fuse duplicate",
      (b) => b.copy(b, 0xd00, 0xc00, 0xc2a),
      /one Electron fuse/,
    ],
    [
      "fuse version",
      (b) => {
        b[0xc20] = 2;
      },
      /unsupported/,
    ],
    [
      "fuse state",
      (b) => {
        b[0xc26] = 0x72;
      },
      /unknown ASAR/,
    ],
    [
      "header mismatch",
      (b) => {
        b.write(after, b.indexOf(before));
      },
      /does not match/,
    ],
    [
      "duplicate language",
      (b) => {
        b.writeUInt16LE(2, 0x24e);
        b.writeUInt32LE(1034, 0x258);
        b.writeUInt32LE(0x60, 0x25c);
      },
      /one ELECTRONASAR/,
    ],
  ];
  for (const [label, change, error] of cases) {
    const binary = windowsExecutable(before);
    change(binary);
    const original = Buffer.from(binary);
    assert.throws(
      () => updateWindowsIntegrity(binary, before, after),
      error,
      label,
    );
    assert.deepEqual(binary, original, label);
  }
  assert.throws(
    () => inspectWindowsIntegrity(Buffer.alloc(4), before),
    /PE executable/,
  );
});
