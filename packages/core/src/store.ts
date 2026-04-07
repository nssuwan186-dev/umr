import { copyFile, link, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { ensureDir, pathExists, removeIfExists } from "./fs";
import type { DataPaths } from "./paths";
import type { SourceMember, StoreStrategy } from "./types";

function resolveMemberPath(rootPath: string, relPath: string): string {
  return path.join(rootPath, ...relPath.split("/"));
}

export class ModelStore {
  constructor(private readonly paths: DataPaths) {}

  async ensureLayout(): Promise<void> {
    await ensureDir(this.paths.root);
    await ensureDir(this.paths.modelsDir);
    await ensureDir(this.paths.importsTmpDir);
    await ensureDir(this.paths.adaptersTmpDir);
  }

  modelRoot(contentDigest: string): string {
    return path.join(this.paths.modelsDir, contentDigest);
  }

  async adoptModel(
    members: SourceMember[],
    contentDigest: string,
    strategy: StoreStrategy,
  ): Promise<{ rootPath: string; method: string }> {
    await this.ensureLayout();

    const rootPath = this.modelRoot(contentDigest);
    if (await pathExists(rootPath)) {
      return { rootPath, method: "existing" };
    }

    const tempRoot = path.join(
      this.paths.importsTmpDir,
      `${contentDigest}.${crypto.randomUUID()}.partial`,
    );
    await removeIfExists(tempRoot);
    await ensureDir(tempRoot);

    const methods = new Set<string>();

    try {
      for (const member of members) {
        const targetPath = resolveMemberPath(tempRoot, member.relPath);
        await ensureDir(path.dirname(targetPath));

        let copied = false;
        if (strategy === "hardlink-or-copy") {
          try {
            await link(member.sourcePath, targetPath);
            methods.add("hardlink");
            copied = true;
          } catch {
            // fall through to copy
          }
        }

        if (!copied) {
          await copyFile(member.sourcePath, targetPath);
          methods.add("copy");
        }
      }

      try {
        await rename(tempRoot, rootPath);
      } catch (error) {
        if (await pathExists(rootPath)) {
          await removeIfExists(tempRoot);
          return { rootPath, method: "existing" };
        }

        throw error;
      }

      return {
        rootPath,
        method:
          methods.size === 0
            ? "existing"
            : methods.size === 1
              ? [...methods][0]
              : "mixed",
      };
    } catch (error) {
      await removeIfExists(tempRoot);
      throw error;
    }
  }

  async removeModelRoot(rootPath: string): Promise<void> {
    await removeIfExists(rootPath);
  }

  async cleanupOrphanTemps(maxAgeMs: number): Promise<string[]> {
    const removed: string[] = [];

    const cleanDir = async (dirPath: string): Promise<void> => {
      if (!(await pathExists(dirPath))) {
        return;
      }

      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        const details = await stat(entryPath);
        if (Date.now() - details.mtimeMs <= maxAgeMs) {
          if (entry.isDirectory()) {
            await cleanDir(entryPath);
          }
          continue;
        }

        await removeIfExists(entryPath);
        removed.push(entryPath);
      }
    };

    await cleanDir(this.paths.importsTmpDir);
    await cleanDir(this.paths.adaptersTmpDir);

    return removed;
  }
}
