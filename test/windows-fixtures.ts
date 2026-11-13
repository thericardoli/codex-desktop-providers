/** Tiny synthetic PE32/PE32+ resources and fuse wire; contains no executable code. */
export function windowsExecutable(
  headerHash: string,
  options: {
    enabled?: boolean;
    resource?: boolean;
    signed?: boolean;
    pe32?: boolean;
  } = {},
): Buffer {
  const pe = 0x80;
  const optional = pe + 24;
  const optionalSize = options.pe32 ? 224 : 240;
  const directories = optional + (options.pe32 ? 96 : 112);
  const section = optional + optionalSize;
  const root = 0x200;
  const binary = Buffer.alloc(0x1000);
  binary.write("MZ");
  binary.writeUInt32LE(pe, 0x3c);
  binary.write("PE\0\0", pe, "ascii");
  binary.writeUInt16LE(options.pe32 ? 0x14c : 0x8664, pe + 4);
  binary.writeUInt16LE(1, pe + 6);
  binary.writeUInt16LE(optionalSize, pe + 20);
  binary.writeUInt16LE(options.pe32 ? 0x10b : 0x20b, optional);
  binary.writeUInt32LE(16, directories - 4);
  binary.write(".rsrc", section);
  binary.writeUInt32LE(0xa00, section + 8);
  binary.writeUInt32LE(0x1000, section + 12);
  binary.writeUInt32LE(0xa00, section + 16);
  binary.writeUInt32LE(root, section + 20);
  if (options.signed) {
    binary.writeUInt32LE(0xe00, directories + 4 * 8);
    binary.writeUInt32LE(16, directories + 4 * 8 + 4);
    binary.write("fake certificate", 0xe00);
  }
  if (options.resource !== false) {
    binary.writeUInt32LE(0x1000, directories + 2 * 8);
    binary.writeUInt32LE(0xa00, directories + 2 * 8 + 4);
    binary.writeUInt16LE(1, root + 12);
    binary.writeUInt32LE(0x80000080, root + 16);
    binary.writeUInt32LE(0x80000020, root + 20);
    binary.writeUInt16LE(1, root + 0x20 + 12);
    binary.writeUInt32LE(0x800000a0, root + 0x20 + 16);
    binary.writeUInt32LE(0x80000040, root + 0x20 + 20);
    binary.writeUInt16LE(1, root + 0x40 + 14);
    binary.writeUInt32LE(1033, root + 0x40 + 16);
    binary.writeUInt32LE(0x60, root + 0x40 + 20);
    binary.writeUInt16LE(9, root + 0x80);
    binary.write("INTEGRITY", root + 0x82, "utf16le");
    binary.writeUInt16LE(12, root + 0xa0);
    binary.write("ELECTRONASAR", root + 0xa2, "utf16le");
    const data = Buffer.from(
      JSON.stringify([
        { file: "resources\\app.asar", alg: "SHA256", value: headerHash },
        { file: "resources\\other.asar", alg: "SHA256", value: "f".repeat(64) },
      ]),
    );
    binary.writeUInt32LE(0x1100, root + 0x60);
    binary.writeUInt32LE(data.length, root + 0x64);
    data.copy(binary, root + 0x100);
  }
  binary.write("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", 0xc00);
  binary[0xc20] = 1;
  binary[0xc21] = 8;
  binary.write(options.enabled === false ? "10000100" : "10001100", 0xc22);
  return binary;
}
