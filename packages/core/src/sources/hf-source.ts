import { ManagerError } from "../errors";
import { parseGGUF } from "../gguf";
import { emitInfo } from "../progress";
import { type CommandRunner, runOrThrow } from "../shell";
import type {
  JsonValue,
  OperationContext,
  ResolvedSource,
  SourceAdapter,
} from "../types";

export interface HFSourceInput {
  repo: string;
  file?: string;
  revision?: string;
}

interface HFModelInfo {
  sha: string;
  siblings: string[];
}

async function resolvePythonCommand(runner: CommandRunner): Promise<string> {
  if (await runner.commandExists("python")) {
    return "python";
  }

  if (await runner.commandExists("python3")) {
    return "python3";
  }

  throw new ManagerError("Python is required for Hugging Face support", {
    code: "missing-python",
    exitCode: 2,
  });
}

async function runPythonJson<T>(
  runner: CommandRunner,
  script: string,
  args: string[],
): Promise<T> {
  const python = await resolvePythonCommand(runner);
  const result = await runOrThrow(runner, python, ["-c", script, ...args]);
  try {
    return JSON.parse(result.stdout.trim()) as T;
  } catch (error) {
    throw new ManagerError("Failed to parse Hugging Face helper output", {
      code: "hf-json",
      exitCode: 1,
      cause: error,
    });
  }
}

export class HFSourceAdapter implements SourceAdapter<HFSourceInput> {
  constructor(private readonly runner: CommandRunner) {}

  kind(): string {
    return "hf";
  }

  describe(input: HFSourceInput) {
    return {
      kind: this.kind(),
      payload: {
        repo: input.repo,
        revision: input.revision ?? null,
        file: input.file ?? null,
      },
    };
  }

  async resolve(
    input: HFSourceInput,
    context?: OperationContext,
  ): Promise<ResolvedSource> {
    await emitInfo(
      context?.reporter,
      `Resolving Hugging Face repo ${input.repo}${input.revision ? ` @ ${input.revision}` : ""}`,
    );
    const info = await runPythonJson<HFModelInfo>(
      this.runner,
      `
import json
import sys
from huggingface_hub import HfApi
repo = sys.argv[1]
revision = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "__none__" else None
info = HfApi().model_info(repo, revision=revision)
print(json.dumps({
  "sha": info.sha,
  "siblings": [s.rfilename for s in info.siblings or []]
}))
      `.trim(),
      [input.repo, input.revision ?? "__none__"],
    );

    const ggufFiles = info.siblings.filter((file) =>
      file.toLowerCase().endsWith(".gguf"),
    );
    const selectedFile =
      input.file ??
      (() => {
        if (ggufFiles.length === 1) {
          return ggufFiles[0];
        }

        throw new ManagerError(
          ggufFiles.length === 0
            ? `No GGUF files found in ${input.repo}`
            : `Multiple GGUF files found in ${input.repo}; pass --file explicitly`,
          {
            code: "hf-file-required",
            exitCode: 2,
          },
        );
      })();

    if (!ggufFiles.includes(selectedFile)) {
      throw new ManagerError(
        `GGUF file not found in ${input.repo}: ${selectedFile}`,
        {
          code: "hf-missing-file",
          exitCode: 2,
        },
      );
    }

    await emitInfo(
      context?.reporter,
      `Fetching ${selectedFile} from the Hugging Face cache`,
    );
    const download = await runPythonJson<{ path: string }>(
      this.runner,
      `
import json
import sys
from huggingface_hub import hf_hub_download
repo = sys.argv[1]
filename = sys.argv[2]
revision = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "__none__" else None
path = hf_hub_download(repo, filename, revision=revision)
print(json.dumps({"path": path}))
      `.trim(),
      [input.repo, selectedFile, info.sha ?? "__none__"],
    );

    await emitInfo(
      context?.reporter,
      `Reading GGUF metadata from ${selectedFile}`,
    );
    const summary = await parseGGUF(download.path);

    return {
      format: summary.format,
      metadata: summary.metadata,
      provenance: {
        repo: input.repo,
        revision: info.sha,
        file: selectedFile,
        cachedPath: download.path,
      } as Record<string, JsonValue>,
      storeStrategy: "hardlink-or-copy",
      entryRelPath: selectedFile,
      members: [
        {
          sourcePath: download.path,
          relPath: selectedFile,
        },
      ],
    };
  }
}
