import { win32 } from "node:path";

const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");

function invalid(message: string): never {
  throw new Error(`Cannot prepare Windows executable: ${message}`);
}

/** Read PE resources without rebuilding sections, certificates or native code. */
function peResources(binary: Buffer) {
  function range(offset: number, size: number): number {
    if (offset < 0 || size < 0 || offset + size > binary.length)
      invalid("truncated PE image");
    return offset;
  }
  const u16 = (offset: number) => binary.readUInt16LE(range(offset, 2));
  const u32 = (offset: number) => binary.readUInt32LE(range(offset, 4));
  if (u16(0) !== 0x5a4d) invalid("expected a Windows PE executable");
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) invalid("missing PE signature");
  const optional = pe + 24;
  const optionalSize = u16(pe + 20);
  const magic = u16(optional);
  if (magic !== 0x10b && magic !== 0x20b)
    invalid("unsupported PE optional header");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (
    optionalSize < directories - optional ||
    u32(directories - 4) < 5 ||
    optionalSize < directories - optional + 5 * 8
  )
    invalid("missing PE data directories");
  range(optional, optionalSize);
  const sectionTable = optional + optionalSize;
  const sections = Array.from({ length: u16(pe + 6) }, (_, index) => {
    const section = range(sectionTable + index * 40, 40);
    return {
      rva: u32(section + 12),
      size: u32(section + 16),
      offset: u32(section + 20),
    };
  });
  function locate(rva: number, size: number): number {
    const matches = sections.filter(
      (section) =>
        rva >= section.rva && rva + size <= section.rva + section.size,
    );
    if (matches.length !== 1)
      invalid("missing or overlapping PE section mapping");
    return range(matches[0]!.offset + rva - matches[0]!.rva, size);
  }
  const signed =
    u32(directories + 4 * 8) !== 0 && u32(directories + 4 * 8 + 4) !== 0;
  const resourceRva = u32(directories + 2 * 8);
  const resourceSize = u32(directories + 2 * 8 + 4);
  if (!resourceRva || !resourceSize) return { signed, resources: [] };
  const root = locate(resourceRva, resourceSize);
  function resourceRange(offset: number, size: number): number {
    if (offset < 0 || offset + size > resourceSize)
      invalid("invalid PE resource offset");
    return root + offset;
  }
  function directory(offset: number) {
    const start = resourceRange(offset, 16);
    const count = u16(start + 12) + u16(start + 14);
    resourceRange(offset + 16, count * 8);
    return Array.from({ length: count }, (_, index) => {
      const entry = start + 16 + index * 8;
      const name = u32(entry);
      const target = u32(entry + 4);
      let label: string | number = name;
      if (name & 0x80000000) {
        const nameOffset = name & 0x7fffffff;
        const length = u16(resourceRange(nameOffset, 2)) * 2;
        const text = resourceRange(nameOffset + 2, length);
        label = binary.subarray(text, text + length).toString("utf16le");
      }
      return {
        label,
        directory: Boolean(target & 0x80000000),
        offset: target & 0x7fffffff,
      };
    });
  }
  const resources: { offset: number; size: number }[] = [];
  for (const type of directory(0)) {
    if (String(type.label).toUpperCase() !== "INTEGRITY") continue;
    if (!type.directory) invalid("invalid INTEGRITY resource directory");
    for (const name of directory(type.offset)) {
      if (String(name.label).toUpperCase() !== "ELECTRONASAR") continue;
      if (!name.directory) invalid("invalid ELECTRONASAR resource directory");
      for (const language of directory(name.offset)) {
        if (language.directory)
          invalid("unexpected nested ELECTRONASAR resource");
        const data = resourceRange(language.offset, 16);
        const size = u32(data + 4);
        resources.push({ offset: locate(u32(data), size), size });
      }
    }
  }
  return { signed, resources };
}

export interface WindowsIntegrity {
  enabled: boolean;
  signed: boolean;
  hashOffset: number | null;
}

/** Electron's documented V1 wire and INTEGRITY/ELECTRONASAR PE resource. */
export function inspectWindowsIntegrity(
  binary: Buffer,
  headerHash: string,
): WindowsIntegrity {
  const { signed, resources } = peResources(binary);
  const start = binary.indexOf(sentinel);
  if (start < 0 || binary.indexOf(sentinel, start + 1) !== -1)
    invalid("expected one Electron fuse wire");
  const wire = start + sentinel.length;
  const length = binary[wire + 1];
  if (
    binary[wire] !== 1 ||
    length === undefined ||
    length <= 4 ||
    wire + 2 + length > binary.length
  )
    invalid("unsupported or truncated Electron fuse wire");
  const state = binary[wire + 2 + 4];
  if (state !== 0x30 && state !== 0x31)
    invalid("unknown ASAR integrity fuse state");
  const enabled = state === 0x31;
  // An inactive resource is not consulted by Electron. Preserve the executable
  // byte-for-byte (and its signature) when this fuse is disabled.
  if (!enabled) return { enabled, signed, hashOffset: null };
  if (resources.length !== 1)
    invalid("expected one ELECTRONASAR integrity resource");
  const resource = resources[0]!;
  const bytes = binary.subarray(
    resource.offset,
    resource.offset + resource.size,
  );
  let records: unknown;
  try {
    records = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("malformed ELECTRONASAR JSON");
  }
  if (!Array.isArray(records)) invalid("expected an ELECTRONASAR array");
  const matches = records.filter(
    (record) =>
      record &&
      typeof record.file === "string" &&
      win32.normalize(record.file).toLowerCase() === "resources\\app.asar",
  );
  if (matches.length !== 1)
    invalid("expected one resources/app.asar integrity record");
  const record = matches[0];
  if (
    typeof record.alg !== "string" ||
    record.alg.toLowerCase() !== "sha256" ||
    typeof record.value !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.value) ||
    record.value.toLowerCase() !== headerHash
  )
    invalid("EXE integrity record does not match the source ASAR header");
  const offset = bytes.indexOf(Buffer.from(record.value));
  if (offset < 0 || bytes.indexOf(Buffer.from(record.value), offset + 1) !== -1)
    invalid("ambiguous or escaped ASAR header digest");
  return { enabled, signed, hashOffset: resource.offset + offset };
}

/** Replace only the existing fixed-width digest; never turn off integrity fuses. */
export function updateWindowsIntegrity(
  binary: Buffer,
  before: string,
  after: string,
) {
  if (!/^[a-f0-9]{64}$/.test(after)) invalid("invalid replacement ASAR digest");
  const info = inspectWindowsIntegrity(binary, before);
  const updated = Buffer.from(binary);
  if (info.hashOffset !== null)
    updated.write(after, info.hashOffset, 64, "ascii");
  inspectWindowsIntegrity(updated, after);
  return {
    binary: updated,
    modified: !updated.equals(binary),
    signed: info.signed,
    enabled: info.enabled,
  };
}
