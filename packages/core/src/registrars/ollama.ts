import path from "node:path";

import { ManagerError } from "../errors";
import { ensureDir, removeFileIfExists, writeTextFile } from "../fs";
import { deriveOllamaName } from "../naming";
import type { DataPaths } from "../paths";
import { emitInfo } from "../progress";
import { type CommandRunner, runOrThrow } from "../shell";
import type {
  ModelDetails,
  ModelRecord,
  OperationContext,
  RegistrarAdapter,
  RegistrationHealth,
  RegistrationRecord,
  RegistrationResult,
} from "../types";

function assertGGUFEntry(model: ModelRecord): void {
  if (!model.entryFilename.toLowerCase().endsWith(".gguf")) {
    throw new ManagerError(
      "UMR currently supports GGUF models only. Support for other model formats is coming soon.",
      {
        code: "unsupported-model-format",
        exitCode: 2,
      },
    );
  }
}

export class OllamaRegistrarAdapter implements RegistrarAdapter {
  constructor(
    private readonly runner: CommandRunner,
    private readonly dataPaths: DataPaths,
  ) {}

  client(): string {
    return "ollama";
  }

  async register(
    model: ModelDetails,
    context?: OperationContext,
  ): Promise<RegistrationResult> {
    assertGGUFEntry(model);
    if (!(await this.runner.commandExists("ollama"))) {
      throw new ManagerError(
        "Ollama does not appear to be installed. Install Ollama, then try linking again.",
        {
          code: "missing-ollama-cli",
          exitCode: 2,
        },
      );
    }
    await ensureDir(path.join(this.dataPaths.adaptersTmpDir, "ollama"));
    const name = deriveOllamaName(model.name, model.ref);
    const modelfilePath = path.join(
      this.dataPaths.adaptersTmpDir,
      "ollama",
      `${model.ref}.Modelfile`,
    );
    await emitInfo(
      context?.reporter,
      `Writing a temporary Modelfile for ${model.name}`,
    );
    await writeTextFile(modelfilePath, `FROM ${model.entryPath}\n`);
    await emitInfo(
      context?.reporter,
      `Creating Ollama model ${name} from the managed GGUF`,
    );
    await runOrThrow(this.runner, "ollama", [
      "create",
      name,
      "-f",
      modelfilePath,
    ]);

    return {
      clientRef: name,
      state: {
        name,
        modelfilePath,
      },
    };
  }

  async unregister(
    _model: ModelDetails,
    registration: RegistrationRecord,
    context?: OperationContext,
  ): Promise<void> {
    const name = registration.clientRef;
    await emitInfo(context?.reporter, `Removing Ollama model ${name}`);
    const result = await this.runner.run("ollama", ["rm", name]);
    if (
      result.exitCode !== 0 &&
      !result.stderr.toLowerCase().includes("not found")
    ) {
      throw new Error(result.stderr || result.stdout);
    }

    const modelfilePath = registration.state.modelfilePath;
    if (typeof modelfilePath === "string") {
      await removeFileIfExists(modelfilePath);
    }
  }

  async check(
    _model: ModelDetails,
    registration: RegistrationRecord,
    _context?: OperationContext,
  ): Promise<RegistrationHealth> {
    const result = await this.runner.run("ollama", [
      "show",
      registration.clientRef,
    ]);
    return result.exitCode === 0
      ? { ok: true, issues: [] }
      : { ok: false, issues: ["missing-ollama-model"] };
  }
}
