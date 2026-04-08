import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

interface HashProgressSink {
  start(task: {
    phase: string;
    label: string;
    totalBytes: number;
  }): void | Promise<void>;
  update(task: {
    phase: string;
    label: string;
    completedBytes: number;
    totalBytes: number;
  }): void | Promise<void>;
  finish(task: {
    phase: string;
    label: string;
    totalBytes: number;
  }): void | Promise<void>;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function sha256File(
  filePath: string,
  options?: {
    progress?: HashProgressSink;
    label?: string;
    totalBytes?: number;
  },
): Promise<string> {
  const hash = createHash("sha256");
  const totalBytes = options?.totalBytes ?? (await fileSize(filePath));
  const label = options?.label ?? path.basename(filePath);

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    let completedBytes = 0;
    void options?.progress?.start({ phase: "Hashing", label, totalBytes });
    stream.on("data", (chunk) => {
      hash.update(chunk);
      completedBytes += chunk.length;
      void options?.progress?.update({
        phase: "Hashing",
        label,
        completedBytes,
        totalBytes,
      });
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });

  await options?.progress?.finish({ phase: "Hashing", label, totalBytes });

  return hash.digest("hex");
}

export async function fileSize(filePath: string): Promise<number> {
  const details = await stat(filePath);
  return details.size;
}

export async function writeTextFile(
  filePath: string,
  contents: string,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await Bun.write(filePath, contents);
}

export async function removeIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true, recursive: true });
  } catch {
    // ignore
  }
}

export async function removeEmptyParents(
  startPath: string,
  stopPath: string,
): Promise<void> {
  let current = path.dirname(startPath);
  const stop = path.resolve(stopPath);

  while (current.startsWith(stop) && current !== stop) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      break;
    }

    if (entries.length > 0) {
      break;
    }

    try {
      await rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as T;
}
