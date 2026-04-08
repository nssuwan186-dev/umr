import { readdir } from "node:fs/promises";
import path from "node:path";

import { RegistrarAdapterRegistry, SourceAdapterRegistry } from "./adapters";
import { ManagerError } from "./errors";
import {
  ensureDir,
  fileSize,
  pathExists,
  removeIfExists,
  sha256File,
} from "./fs";
import { readGGUFHeader } from "./gguf";
import {
  deriveContentDigest,
  deriveModelName,
  deriveModelRef,
  reserveUniqueModelName,
} from "./naming";
import type { DataPaths } from "./paths";
import { emitInfo, emitSuccess, emitWarning } from "./progress";
import { Registry } from "./registry";
import {
  type HFRepoInspection,
  HFSourceAdapter,
  type HFSourceInput,
} from "./sources/hf-source";
import { ModelStore } from "./store";
import type {
  CheckIssue,
  CheckRepair,
  CheckResult,
  JsonValue,
  ModelDetails,
  ModelManifestMember,
  ModelRecord,
  OperationContext,
  ProgressReporter,
  RegistrationRecord,
  ResolvedSource,
  SourceMember,
} from "./types";

export interface AddModelResult {
  model: ModelDetails;
  status: "tracked" | "existing";
}

export interface UnifiedModelRegistryOptions {
  dataPaths: DataPaths;
  registry?: Registry;
  store?: ModelStore;
  sourceAdapters?: SourceAdapterRegistry;
  registrarAdapters?: RegistrarAdapterRegistry;
}

async function safeCleanup(resolvedSource: ResolvedSource): Promise<void> {
  await resolvedSource.cleanup?.();
}

async function buildManifest(members: SourceMember[]): Promise<{
  manifest: ModelManifestMember[];
  totalSizeBytes: number;
}> {
  const manifest: ModelManifestMember[] = [];
  let totalSizeBytes = 0;

  for (const member of members) {
    let sha256 = member.sha256;
    let sizeBytes = member.sizeBytes;

    if (!sha256 || typeof sizeBytes !== "number") {
      const computed = await Promise.all([
        sha256File(member.sourcePath),
        fileSize(member.sourcePath),
      ]);
      [sha256, sizeBytes] = computed;
    }

    manifest.push({
      relPath: member.relPath,
      sha256,
      sizeBytes,
    });
    totalSizeBytes += sizeBytes;
  }

  return { manifest, totalSizeBytes };
}

function describeModelHealth(
  rootExists: boolean,
  entryExists: boolean,
): "ok" | "missing" {
  return rootExists && entryExists ? "ok" : "missing";
}

function formatTargetLabel(target: string): string {
  switch (target) {
    case "lmstudio":
      return "LM Studio";
    case "ollama":
      return "Ollama";
    case "jan":
      return "Jan";
    default:
      return target;
  }
}

export class UnifiedModelRegistry {
  readonly registry: Registry;
  readonly store: ModelStore;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly registrarAdapters: RegistrarAdapterRegistry;

  constructor(private readonly options: UnifiedModelRegistryOptions) {
    this.registry = options.registry ?? new Registry(options.dataPaths);
    this.store = options.store ?? new ModelStore(options.dataPaths);
    this.sourceAdapters = options.sourceAdapters ?? new SourceAdapterRegistry();
    this.registrarAdapters =
      options.registrarAdapters ?? new RegistrarAdapterRegistry();
  }

  hasSourceAdapter(kind: string): boolean {
    return this.sourceAdapters.has(kind);
  }

  listExplicitSourceKinds(): string[] {
    return this.sourceAdapters
      .all()
      .map((adapter) => adapter.kind())
      .filter((kind) => kind !== "path");
  }

  async inspectHFSource(
    input: HFSourceInput,
    context?: OperationContext,
  ): Promise<HFRepoInspection> {
    const adapter = this.sourceAdapters.get("hf");
    if (!(adapter instanceof HFSourceAdapter)) {
      throw new ManagerError("HF source adapter is not available", {
        code: "missing-hf-adapter",
        exitCode: 2,
      });
    }

    return adapter.inspect(input, context);
  }

  findTrackedSource(
    kind: string,
    payload: Record<string, JsonValue>,
  ): ModelDetails | null {
    const model = this.registry.findModelBySource(kind, payload);
    if (!model) {
      return null;
    }

    return this.registry.getModelDetails(model.ref);
  }

  private resolveModelDetails(selector: string): ModelDetails {
    const byRef = this.registry.getModelByRef(selector);
    if (byRef) {
      return this.registry.getModelDetails(byRef.ref) as ModelDetails;
    }

    const byName = this.registry.listModelsByName(selector);
    if (byName.length === 1) {
      return this.registry.getModelDetails(byName[0].ref) as ModelDetails;
    }

    if (byName.length > 1) {
      throw new ManagerError(
        `Model name is ambiguous: ${selector}. Use one of: ${byName.map((model) => model.ref).join(", ")}`,
        {
          code: "ambiguous-model",
          exitCode: 2,
        },
      );
    }

    throw new ManagerError(`Model not found: ${selector}`, {
      code: "missing-model",
      exitCode: 2,
    });
  }

  async addSource(
    kind: string,
    input: unknown,
    context?: OperationContext,
  ): Promise<AddModelResult> {
    const adapter = this.sourceAdapters.get(kind);
    await emitInfo(context?.reporter, `Resolving ${kind} source`);
    const resolved = await adapter.resolve(input, context);

    try {
      const needsHashing = resolved.members.some(
        (member) => !member.sha256 || typeof member.sizeBytes !== "number",
      );
      await emitInfo(
        context?.reporter,
        needsHashing
          ? "Hashing resolved model members"
          : "Preparing model manifest",
      );
      const { manifest, totalSizeBytes } = await buildManifest(
        resolved.members,
      );
      const contentDigest = deriveContentDigest(manifest);
      const existing = this.registry.getModelByContentDigest(contentDigest);
      if (existing) {
        await emitInfo(
          context?.reporter,
          `Model content already tracked as ${existing.name} (${existing.ref})`,
        );
        this.registry.addSource(
          existing.id,
          adapter.kind(),
          resolved.provenance,
        );
        await emitSuccess(
          context?.reporter,
          `Recorded ${kind} source for existing model ${existing.name}`,
        );
        return {
          status: "existing",
          model: this.getModel(existing.ref),
        };
      }

      const ref = deriveModelRef(contentDigest, (candidate: string) =>
        this.registry.isRefTaken(candidate),
      );
      const name = reserveUniqueModelName(
        deriveModelName(resolved.entryRelPath, resolved.metadata),
        (candidate: string) => this.registry.isNameTaken(candidate),
      );
      await emitInfo(
        context?.reporter,
        "Adopting model into the managed model root store",
      );
      const stored = await this.store.adoptModel(
        resolved.members,
        contentDigest,
        resolved.storeStrategy,
      );
      await emitInfo(context?.reporter, "Recording model in the registry");
      const model = this.registry.createModel({
        ref,
        name,
        contentDigest,
        totalSizeBytes,
        rootPath: stored.rootPath,
        entryRelPath: resolved.entryRelPath,
        format: resolved.format,
        metadata: resolved.metadata,
        manifest,
        createdAt: Date.now(),
      });

      this.registry.addSource(model.id, adapter.kind(), resolved.provenance);
      await emitSuccess(
        context?.reporter,
        `Tracked ${model.name} as ${model.ref}`,
      );

      return {
        status: "tracked",
        model: this.getModel(model.ref),
      };
    } finally {
      await safeCleanup(resolved);
    }
  }

  async listModels(): Promise<
    Array<ModelRecord & { registrations: string[]; health: "ok" | "missing" }>
  > {
    return Promise.all(
      this.registry.listModels().map(async (model) => {
        const [rootExists, entryExists] = await Promise.all([
          pathExists(model.rootPath),
          pathExists(model.entryPath),
        ]);
        return {
          ...model,
          registrations: this.registry
            .listRegistrations(model.id)
            .map((registration: RegistrationRecord) => registration.client),
          health: describeModelHealth(rootExists, entryExists),
        };
      }),
    );
  }

  getModel(selector: string): ModelDetails {
    return this.resolveModelDetails(selector);
  }

  async link(
    client: string,
    selector: string,
    context?: OperationContext,
  ): Promise<RegistrationRecord> {
    const registrar = this.registrarAdapters.get(client);
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    await emitInfo(context?.reporter, `Linking ${model.name} to ${client}`);
    const result = await registrar.register(model, context);
    const registration = this.registry.upsertRegistration(
      model.id,
      client,
      result.clientRef,
      result.state,
    );
    await emitSuccess(
      context?.reporter,
      `Linked ${model.name} to ${client} as ${registration.clientRef}`,
    );
    return registration;
  }

  async unlink(
    client: string,
    selector: string,
    context?: OperationContext,
  ): Promise<void> {
    const registrar = this.registrarAdapters.get(client);
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    const registration = this.registry.getRegistration(model.id, client);
    if (!registration) {
      throw new ManagerError(`Model ${selector} is not linked to ${client}`, {
        code: "missing-link",
        exitCode: 2,
      });
    }

    await emitInfo(
      context?.reporter,
      `Removing ${client} link for ${model.name}`,
    );
    await registrar.unregister(model, registration, context);
    this.registry.deleteRegistration(model.id, client);
    await emitSuccess(
      context?.reporter,
      `Removed ${client} link for ${model.name}`,
    );
  }

  async remove(selector: string, context?: OperationContext): Promise<void> {
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    if (model.registrations.length > 0) {
      const unlinkCommands = model.registrations
        .map(
          (registration) => `  umr unlink ${registration.client} ${model.name}`,
        )
        .join("\n");
      throw new ManagerError(
        `Cannot remove model ${model.name} while links exist.\n\nUnlink it first:\n${unlinkCommands}`,
        {
          code: "model-still-linked",
          exitCode: 2,
        },
      );
    }

    await emitInfo(
      context?.reporter,
      `Deleting managed model root ${model.rootPath}`,
    );
    await this.store.removeModelRoot(model.rootPath);
    await emitInfo(
      context?.reporter,
      `Removing ${model.name} from the registry`,
    );
    this.registry.deleteModel(model.id);
    await emitSuccess(
      context?.reporter,
      `Removed ${model.name} from managed storage`,
    );
  }

  async check(options?: {
    fix?: boolean;
    reporter?: ProgressReporter;
  }): Promise<CheckResult> {
    const issues: CheckIssue[] = [];
    const repairs: CheckRepair[] = [];
    const models = this.registry.listModels();
    await emitInfo(
      options?.reporter,
      `Checking ${models.length} tracked model${models.length === 1 ? "" : "s"}`,
    );

    for (const model of models) {
      await emitInfo(options?.reporter, `Checking ${model.name}`);

      if (!(await pathExists(model.rootPath))) {
        issues.push({
          severity: "error",
          ref: model.name,
          code: "missing-model-root",
          fixable: false,
        });
        continue;
      }

      if (!(await pathExists(model.entryPath))) {
        issues.push({
          severity: "error",
          ref: model.name,
          code: "missing-entry-path",
          fixable: false,
        });
      }

      for (const member of model.manifest) {
        const memberPath = path.join(
          model.rootPath,
          ...member.relPath.split("/"),
        );
        if (!(await pathExists(memberPath))) {
          issues.push({
            severity: "error",
            ref: model.name,
            code: `missing-member:${member.relPath}`,
            fixable: false,
          });
          continue;
        }

        const actualSize = await fileSize(memberPath);
        if (actualSize !== member.sizeBytes) {
          issues.push({
            severity: "error",
            ref: model.name,
            code: `member-size-mismatch:${member.relPath}`,
            fixable: false,
          });
        }
      }

      if (await pathExists(model.entryPath)) {
        try {
          await readGGUFHeader(model.entryPath);
        } catch (error) {
          issues.push({
            severity: "error",
            ref: model.name,
            code: `invalid-gguf:${(error as Error).message}`,
            fixable: false,
          });
        }
      }

      const registrations = this.registry.listRegistrations(model.id);
      for (const registration of registrations) {
        const registrar = this.registrarAdapters.get(registration.client);
        const targetLabel = formatTargetLabel(registration.client);
        const details = this.getModel(model.ref);
        const health = await registrar.check(details, registration, {
          reporter: options?.reporter,
        });
        if (!health.ok) {
          issues.push({
            severity: "warning",
            ref: model.name,
            code: `${registration.client}:${health.issues.join(",")}`,
            fixable: true,
          });

          if (options?.fix) {
            this.registry.deleteRegistrationById(registration.id);
            repairs.push({
              ref: model.name,
              message: `Removed stale ${targetLabel} link.`,
            });
            await emitWarning(
              options?.reporter,
              `Removed stale ${targetLabel} link for ${model.name}`,
            );
          }
        }
      }
    }

    let fixed = false;
    if (options?.fix) {
      fixed = true;
      await emitInfo(options?.reporter, "Cleaning stale temporary files");
      repairs.push(...(await this.cleanTempFiles()));
      await emitInfo(options?.reporter, "Cleaning orphaned model roots");
      repairs.push(...(await this.cleanOrphanModelRoots()));
      await emitSuccess(options?.reporter, "Finished safe repair pass");
    }

    return {
      checkedModels: models.length,
      ok:
        issues.filter((issue) => issue.severity === "error").length === 0 &&
        issues.length === 0,
      fixed,
      issues,
      repairs,
    };
  }

  private async cleanTempFiles(): Promise<CheckRepair[]> {
    const repairs: CheckRepair[] = [];
    const removed = await this.store.cleanupOrphanTemps(24 * 60 * 60 * 1000);
    for (const filePath of removed) {
      repairs.push({
        message: `Removed stale temporary file ${path.basename(filePath)}.`,
      });
    }
    return repairs;
  }

  private async cleanOrphanModelRoots(): Promise<CheckRepair[]> {
    const repairs: CheckRepair[] = [];
    await ensureDir(this.options.dataPaths.modelsDir);
    const known = new Set(
      this.registry
        .listModels()
        .map((model: ModelRecord) => model.contentDigest),
    );
    const directories = await readdir(this.options.dataPaths.modelsDir);
    for (const directory of directories) {
      if (!known.has(directory)) {
        await removeIfExists(
          path.join(this.options.dataPaths.modelsDir, directory),
        );
        repairs.push({
          message: `Removed orphaned model root ${directory}.`,
        });
      }
    }
    return repairs;
  }
}
