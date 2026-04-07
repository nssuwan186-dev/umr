import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function encodeString(value: string): Buffer {
  const text = Buffer.from(value, "utf8");
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(text.length), 0);
  return Buffer.concat([size, text]);
}

function encodeStringValue(key: string, value: string): Buffer {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(8, 0);
  return Buffer.concat([encodeString(key), type, encodeString(value)]);
}

export async function createTestGGUF(
  filePath: string,
  metadata: Record<string, string> = {
    "general.name": "Tiny Test Model",
  },
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const header = Buffer.alloc(4 + 4 + 8 + 8);
  header.write("GGUF", 0, "ascii");
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(BigInt(Object.keys(metadata).length), 16);

  const body = Object.entries(metadata).map(([key, value]) =>
    encodeStringValue(key, value),
  );
  await writeFile(filePath, Buffer.concat([header, ...body]));
}
