import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ManagerError } from "../errors";
import { ensureDir, pathExists, removeIfExists, writeTextFile } from "../fs";
import { emitInfo } from "../progress";
import type {
  JsonValue,
  ModelDetails,
  ModelManifestMember,
  ModelRecord,
  OperationContext,
  RegistrarAdapter,
  RegistrationHealth,
  RegistrationRecord,
  RegistrationResult,
} from "../types";

function slugifySegment(input: string): string {
  return input
    .trim()
    .replace(/\.gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function getEntryMember(model: ModelRecord): ModelManifestMember | null {
  return (
    model.manifest.find((member) => member.relPath === model.entryRelPath) ??
    null
  );
}

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

function getDisplayName(model: ModelRecord): string {
  const metadataName = model.metadata["general.name"];
  return typeof metadataName === "string" && metadataName.trim().length > 0
    ? metadataName.trim()
    : model.name;
}

function deriveModelId(model: ModelRecord): string {
  const base = slugifySegment(model.name) || "model";
  return `umr-${base}-${model.ref.slice(2, 10)}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildModelConfig(model: ModelRecord): string {
  const entryMember = getEntryMember(model);
  if (!entryMember) {
    throw new ManagerError(`Missing entry manifest member for ${model.ref}`, {
      code: "missing-entry-member",
      exitCode: 1,
    });
  }

  return [
    `model_path: ${yamlString(model.entryPath)}`,
    `name: ${yamlString(getDisplayName(model))}`,
    `size_bytes: ${entryMember.sizeBytes}`,
    "embedding: false",
    `model_sha256: ${entryMember.sha256}`,
    "",
  ].join("\n");
}

export class JanRegistrarAdapter implements RegistrarAdapter {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  client(): string {
    return "jan";
  }

  private resolveJanDataDir(): string {
    const override = this.env.UMR_JAN_DATA_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }

    const home = this.env.HOME ?? process.env.HOME;
    const xdgConfigHome = this.env.XDG_CONFIG_HOME?.trim();
    const appData = this.env.APPDATA?.trim();
    const defaultPath =
      process.platform === "win32"
        ? appData
          ? path.join(appData, "Jan", "data")
          : home
            ? path.join(home, "AppData", "Roaming", "Jan", "data")
            : null
        : process.platform === "darwin"
          ? home
            ? path.join(home, "Library", "Application Support", "Jan", "data")
            : null
          : xdgConfigHome
            ? path.join(xdgConfigHome, "Jan", "data")
            : home
              ? path.join(home, ".config", "Jan", "data")
              : null;

    const candidates = [
      defaultPath,
      home ? path.join(home, "jan") : null,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    throw new ManagerError(
      "Jan does not appear to be installed. Install Jan or set UMR_JAN_DATA_DIR, then try linking again.",
      {
        code: "jan-data-dir",
        exitCode: 2,
      },
    );
  }

  private getModelDir(modelId: string): string {
    return path.join(this.resolveJanDataDir(), "llamacpp", "models", modelId);
  }

  private getConfigPath(modelId: string): string {
    return path.join(this.getModelDir(modelId), "model.yml");
  }

  async register(
    model: ModelDetails,
    context?: OperationContext,
  ): Promise<RegistrationResult> {
    assertGGUFEntry(model);
    const modelId = deriveModelId(model);
    const modelDir = this.getModelDir(modelId);
    const configPath = this.getConfigPath(modelId);
    const configContents = buildModelConfig(model);

    await emitInfo(
      context?.reporter,
      `Writing Jan model config for ${model.name}`,
    );
    await ensureDir(modelDir);
    await writeTextFile(configPath, configContents);

    return {
      clientRef: modelId,
      state: {
        modelId,
        modelDir,
        configPath,
        janDataDir: this.resolveJanDataDir(),
      } satisfies Record<string, JsonValue>,
    };
  }

  async unregister(
    _model: ModelDetails,
    registration: RegistrationRecord,
    context?: OperationContext,
  ): Promise<void> {
    const modelDir = registration.state.modelDir;
    if (typeof modelDir !== "string") {
      return;
    }

    await emitInfo(
      context?.reporter,
      `Removing Jan model config ${registration.clientRef}`,
    );
    await removeIfExists(modelDir);
  }

  async check(
    model: ModelDetails,
    registration: RegistrationRecord,
    _context?: OperationContext,
  ): Promise<RegistrationHealth> {
    const configPath = registration.state.configPath;
    if (typeof configPath !== "string") {
      return { ok: false, issues: ["missing-jan-config-path"] };
    }

    if (!(await pathExists(configPath))) {
      return { ok: false, issues: ["missing-jan-model-config"] };
    }

    const expected = buildModelConfig(model).trim();
    const actual = (await readFile(configPath, "utf8")).trim();
    if (actual !== expected) {
      return { ok: false, issues: ["stale-jan-model-config"] };
    }

    return { ok: true, issues: [] };
  }
}
