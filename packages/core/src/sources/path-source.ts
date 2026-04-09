import { stat } from "node:fs/promises";
import path from "node:path";

import { ManagerError } from "../errors";
import { pathExists } from "../fs";
import { readGGUFHeader } from "../gguf";
import { emitInfo } from "../progress";
import type { OperationContext, ResolvedSource, SourceAdapter } from "../types";

export interface PathSourceInput {
  path: string;
}

const NON_GGUF_MESSAGE =
  "UMR currently supports GGUF models only. Support for other model formats is coming soon.";

export class PathSourceAdapter implements SourceAdapter<PathSourceInput> {
  kind(): string {
    return "path";
  }

  describe(input: PathSourceInput) {
    return {
      kind: this.kind(),
      payload: {
        originalPath: path.resolve(input.path),
      },
    };
  }

  async resolve(
    input: PathSourceInput,
    context?: OperationContext,
  ): Promise<ResolvedSource> {
    const localPath = path.resolve(input.path);
    await emitInfo(
      context?.reporter,
      `Inspecting local model path ${localPath}`,
    );
    if (!(await pathExists(localPath))) {
      throw new ManagerError(`Path not found: ${localPath}`, {
        code: "missing-path",
        exitCode: 2,
      });
    }

    const details = await stat(localPath);
    if (details.isDirectory()) {
      throw new ManagerError(NON_GGUF_MESSAGE, {
        code: "unsupported-model-format",
        exitCode: 2,
      });
    }

    if (!localPath.toLowerCase().endsWith(".gguf")) {
      throw new ManagerError(NON_GGUF_MESSAGE, {
        code: "unsupported-model-format",
        exitCode: 2,
      });
    }

    await emitInfo(
      context?.reporter,
      `Validating GGUF header for ${localPath}`,
    );
    const header = await readGGUFHeader(localPath);
    const relPath = path.basename(localPath);

    return {
      format: header.format,
      metadata: {},
      provenance: {
        originalPath: localPath,
      },
      storeStrategy: "copy",
      entryRelPath: relPath,
      members: [
        {
          sourcePath: localPath,
          relPath,
        },
      ],
    };
  }
}
