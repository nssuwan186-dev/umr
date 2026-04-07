import { open } from "node:fs/promises";

import { ManagerError } from "./errors";
import type { JsonValue } from "./types";

const GGUF_MAGIC = "GGUF";

enum GGUFValueType {
  Uint8 = 0,
  Int8 = 1,
  Uint16 = 2,
  Int16 = 3,
  Uint32 = 4,
  Int32 = 5,
  Float32 = 6,
  Bool = 7,
  String = 8,
  Array = 9,
  Uint64 = 10,
  Int64 = 11,
  Float64 = 12,
}

class FileCursor {
  #offset = 0;

  constructor(
    private readonly filePath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
  ) {}

  async readExactly(length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(
      buffer,
      0,
      length,
      this.#offset,
    );
    if (bytesRead !== length) {
      throw new ManagerError(`Unexpected EOF while reading ${this.filePath}`, {
        code: "invalid-gguf",
        exitCode: 2,
      });
    }

    this.#offset += length;
    return buffer;
  }

  async readU32(): Promise<number> {
    const buffer = await this.readExactly(4);
    return buffer.readUInt32LE(0);
  }

  async readU64(): Promise<number> {
    const buffer = await this.readExactly(8);
    const value = buffer.readBigUInt64LE(0);
    return Number(value);
  }

  async readI8(): Promise<number> {
    const buffer = await this.readExactly(1);
    return buffer.readInt8(0);
  }

  async readU8(): Promise<number> {
    const buffer = await this.readExactly(1);
    return buffer.readUInt8(0);
  }

  async readI16(): Promise<number> {
    const buffer = await this.readExactly(2);
    return buffer.readInt16LE(0);
  }

  async readU16(): Promise<number> {
    const buffer = await this.readExactly(2);
    return buffer.readUInt16LE(0);
  }

  async readI32(): Promise<number> {
    const buffer = await this.readExactly(4);
    return buffer.readInt32LE(0);
  }

  async readFloat32(): Promise<number> {
    const buffer = await this.readExactly(4);
    return buffer.readFloatLE(0);
  }

  async readFloat64(): Promise<number> {
    const buffer = await this.readExactly(8);
    return buffer.readDoubleLE(0);
  }

  async readI64(): Promise<number> {
    const buffer = await this.readExactly(8);
    return Number(buffer.readBigInt64LE(0));
  }

  async readBool(): Promise<boolean> {
    return (await this.readU8()) !== 0;
  }

  async readString(): Promise<string> {
    const length = await this.readU64();
    if (length > 1024 * 1024) {
      throw new ManagerError(
        `GGUF string is unexpectedly large in ${this.filePath}`,
        {
          code: "invalid-gguf",
          exitCode: 2,
        },
      );
    }

    const buffer = await this.readExactly(length);
    return buffer.toString("utf8");
  }
}

async function readValue(
  cursor: FileCursor,
  type: GGUFValueType,
): Promise<JsonValue> {
  switch (type) {
    case GGUFValueType.Uint8:
      return cursor.readU8();
    case GGUFValueType.Int8:
      return cursor.readI8();
    case GGUFValueType.Uint16:
      return cursor.readU16();
    case GGUFValueType.Int16:
      return cursor.readI16();
    case GGUFValueType.Uint32:
      return cursor.readU32();
    case GGUFValueType.Int32:
      return cursor.readI32();
    case GGUFValueType.Float32:
      return cursor.readFloat32();
    case GGUFValueType.Bool:
      return cursor.readBool();
    case GGUFValueType.String:
      return cursor.readString();
    case GGUFValueType.Uint64:
      return cursor.readU64();
    case GGUFValueType.Int64:
      return cursor.readI64();
    case GGUFValueType.Float64:
      return cursor.readFloat64();
    case GGUFValueType.Array: {
      const innerType = (await cursor.readU32()) as GGUFValueType;
      const length = await cursor.readU64();
      const values: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        values.push(await readValue(cursor, innerType));
      }

      return values;
    }
    default:
      throw new ManagerError(`Unsupported GGUF value type: ${type}`, {
        code: "invalid-gguf",
        exitCode: 2,
      });
  }
}

export interface GGUFSummary {
  format: "gguf";
  version: number;
  tensorCount: number;
  metadata: Record<string, JsonValue>;
}

export async function parseGGUF(filePath: string): Promise<GGUFSummary> {
  const handle = await open(filePath, "r");
  try {
    const cursor = new FileCursor(filePath, handle);
    const magic = (await cursor.readExactly(4)).toString("ascii");
    if (magic !== GGUF_MAGIC) {
      throw new ManagerError(`${filePath} is not a GGUF file`, {
        code: "invalid-gguf",
        exitCode: 2,
      });
    }

    const version = await cursor.readU32();
    const tensorCount = await cursor.readU64();
    const metadataCount = await cursor.readU64();
    const metadata: Record<string, JsonValue> = {};

    for (let index = 0; index < metadataCount; index += 1) {
      const key = await cursor.readString();
      const valueType = (await cursor.readU32()) as GGUFValueType;
      metadata[key] = await readValue(cursor, valueType);
    }

    return {
      format: "gguf",
      version,
      tensorCount,
      metadata,
    };
  } finally {
    await handle.close();
  }
}
