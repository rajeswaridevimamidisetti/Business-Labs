import { deflateRawSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type Entry = { name: string; data: Buffer };
const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(data: Buffer): number { let value = 0xffffffff; for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function u16(value: number): Buffer { const output = Buffer.alloc(2); output.writeUInt16LE(value, 0); return output; }
function u32(value: number): Buffer { const output = Buffer.alloc(4); output.writeUInt32LE(value >>> 0, 0); return output; }

function zip(entries: Entry[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8"); const compressed = deflateRawSync(entry.data); const checksum = crc32(entry.data);
    const header = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum), u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), name]);
    local.push(header, compressed);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum), u32(compressed.length), u32(entry.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += header.length + compressed.length;
  }
  const centralData = Buffer.concat(central);
  return Buffer.concat([...local, centralData, Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralData.length), u32(offset), u16(0)]);
}

function collectFiles(root: string): Entry[] {
  const entries: Entry[] = [];
  const visit = (absolute: string, archiveName: string): void => {
    if (!existsSync(absolute)) return;
    if (statSync(absolute).isDirectory()) { for (const name of readdirSync(absolute)) visit(join(absolute, name), `${archiveName}/${name}`); return; }
    if (/\.enc$|\.env($|\.)/i.test(absolute) || /(^|[\\/])(node_modules|\.git|dist|__pycache__|\.pytest_cache|\.uv-cache)([\\/]|$)/i.test(absolute)) return;
    entries.push({ name: archiveName, data: readFileSync(absolute) });
  };
  for (const dataRoot of ["task1-knowledge-brain/data", "task2-inbox-agent/data", "task3-meeting-to-scope/data"]) visit(resolve(root, dataRoot), dataRoot);
  return entries;
}

export function createDataExport(root = process.env.BUSINESS_LABS_ROOT ?? resolve(process.cwd(), "..")): Buffer {
  const entries = collectFiles(root);
  entries.push({ name: "EXPORT_README.txt", data: Buffer.from("Business-Labs local data export. Secrets, OAuth tokens, environment files, caches, dependencies, and build artifacts are intentionally excluded.\n", "utf8") });
  return zip(entries);
}
