import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type ExternalTranslationPackage = {
  packageVersion: string;
  contractId: string;
  files: Record<string, string>;
};

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}
function join(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Creates a standards-compliant ZIP using STORE, without adding a runtime dependency. */
export function createZip(files: Record<string, string>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [name, content] of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const localHeader = join([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes
    ]);
    local.push(localHeader, data);
    const centralHeader = join([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]);
    central.push(centralHeader);
    offset += localHeader.length + data.length;
  }
  const centralBytes = join(central);
  const localBytes = join(local);
  const end = join([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(localBytes.length), u16(0)
  ]);
  return join([localBytes, centralBytes, end]);
}

/** Uses a native save dialog and filesystem write, avoiding unreliable WebView blob downloads. */
export async function downloadExternalTranslationPackage(pkg: ExternalTranslationPackage): Promise<boolean> {
  const path = await save({
    title: "Salvar pacote para IA externa",
    defaultPath: `nova-editorial-${pkg.packageVersion}.zip`,
    filters: [{ name: "Pacote ZIP", extensions: ["zip"] }]
  });
  if (!path) return false;

  const bytes = createZip(pkg.files);
  await invoke("save_external_translation_package", {
    path,
    bytes: Array.from(bytes)
  });
  return true;
}
