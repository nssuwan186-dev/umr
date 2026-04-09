import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ManagerError } from "../errors";
import { readGGUFHeader } from "../gguf";
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

export interface HFRepoInspection {
  repo: string;
  resolvedRevision: string;
  ggufFiles: string[];
  cachedFiles: string[];
  fileMetadata: Record<string, { sha256?: string; sizeBytes?: number }>;
}

interface HFModelInfo {
  sha: string;
  siblings: Array<{
    rfilename: string;
    sha256?: string;
    sizeBytes?: number;
  }>;
  cachedSiblings: string[];
}

const NON_GGUF_REPO_MESSAGE =
  "This repo does not contain any GGUF files. UMR currently supports GGUF models only. Support for other model formats is coming soon.";

function formatGGUFFiles(files: string[]): string {
  return files.map((file) => `  - ${file}`).join("\n");
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

  async inspect(
    input: HFSourceInput,
    context?: OperationContext,
  ): Promise<HFRepoInspection> {
    await emitInfo(
      context?.reporter,
      `Resolving Hugging Face repo ${input.repo}${input.revision ? ` @ ${input.revision}` : ""}`,
    );
    const info = await runPythonJson<HFModelInfo>(
      this.runner,
      `
import json
import sys
from huggingface_hub import HfApi, try_to_load_from_cache
repo = sys.argv[1]
revision = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "__none__" else None
info = HfApi().model_info(repo, revision=revision, files_metadata=True)
print(json.dumps({
  "sha": info.sha,
  "siblings": [
    {
      "rfilename": sibling.rfilename,
      "sha256": getattr(sibling.lfs, "sha256", None),
      "sizeBytes": sibling.size,
    }
    for sibling in info.siblings or []
  ],
  "cachedSiblings": [
    sibling.rfilename
    for sibling in info.siblings or []
    if sibling.rfilename.lower().endswith(".gguf")
    and isinstance(
      try_to_load_from_cache(repo, sibling.rfilename, revision=info.sha),
      str,
    )
  ]
}))
      `.trim(),
      [input.repo, input.revision ?? "__none__"],
    );

    const ggufSiblings = info.siblings.filter((sibling) =>
      sibling.rfilename.toLowerCase().endsWith(".gguf"),
    );
    const ggufFiles = ggufSiblings.map((sibling) => sibling.rfilename);

    if (ggufFiles.length === 0) {
      throw new ManagerError(NON_GGUF_REPO_MESSAGE, {
        code: "unsupported-model-format",
        exitCode: 2,
      });
    }

    return {
      repo: input.repo,
      resolvedRevision: info.sha,
      ggufFiles,
      cachedFiles: info.cachedSiblings,
      fileMetadata: Object.fromEntries(
        ggufSiblings.map((sibling) => [
          sibling.rfilename,
          {
            sha256: sibling.sha256,
            sizeBytes: sibling.sizeBytes,
          },
        ]),
      ),
    };
  }

  async resolve(
    input: HFSourceInput,
    context?: OperationContext,
  ): Promise<ResolvedSource> {
    const inspection = await this.inspect(input, context);
    const { ggufFiles } = inspection;
    const selectedFile =
      input.file ??
      (() => {
        if (ggufFiles.length === 1) {
          return ggufFiles[0];
        }

        throw new ManagerError(
          ggufFiles.length === 0
            ? NON_GGUF_REPO_MESSAGE
            : `Multiple GGUF files found in ${input.repo}; pass --file explicitly:\n${formatGGUFFiles(ggufFiles)}`,
          {
            code: "hf-file-required",
            exitCode: 2,
          },
        );
      })();

    if (!ggufFiles.includes(selectedFile)) {
      throw new ManagerError(
        `GGUF file not found in ${input.repo}: ${selectedFile}\nAvailable GGUF files:\n${formatGGUFFiles(ggufFiles)}`,
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
    const python = await resolvePythonCommand(this.runner);
    const tempDir = await mkdtemp(path.join(tmpdir(), "umr-hf-download-"));
    const outputPath = path.join(tempDir, "result.json");
    let downloadPath: string;
    try {
      const download = await this.runner.runStreaming(
        python,
        [
          "-c",
          `
import json
import sys
from huggingface_hub import hf_hub_download
repo = sys.argv[1]
filename = sys.argv[2]
revision = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "__none__" else None
output_path = sys.argv[4]
path = hf_hub_download(repo, filename, revision=revision)
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump({"path": path}, handle)
      `.trim(),
          input.repo,
          selectedFile,
          inspection.resolvedRevision,
          outputPath,
        ],
        {
          stdio: "inherit",
        },
      );
      if (download.exitCode !== 0) {
        throw new ManagerError("Failed to download from Hugging Face", {
          code: "hf-download-failed",
          exitCode: 1,
        });
      }

      try {
        downloadPath = (
          JSON.parse(await readFile(outputPath, "utf8")) as { path: string }
        ).path;
      } catch (error) {
        throw new ManagerError("Failed to parse Hugging Face download output", {
          code: "hf-json",
          exitCode: 1,
          cause: error,
        });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    if (!downloadPath) {
      throw new ManagerError("Failed to determine Hugging Face download path", {
        code: "hf-json",
        exitCode: 1,
      });
    }

    await emitInfo(
      context?.reporter,
      `Validating GGUF header for ${selectedFile}`,
    );
    const summary = await readGGUFHeader(downloadPath);

    return {
      format: summary.format,
      metadata: {},
      provenance: {
        repo: input.repo,
        revision: inspection.resolvedRevision,
        file: selectedFile,
      } as Record<string, JsonValue>,
      storeStrategy: "hardlink-or-copy",
      entryRelPath: selectedFile,
      members: [
        {
          sourcePath: downloadPath,
          relPath: selectedFile,
          sha256: inspection.fileMetadata[selectedFile]?.sha256,
          sizeBytes: inspection.fileMetadata[selectedFile]?.sizeBytes,
        },
      ],
    };
  }
}
