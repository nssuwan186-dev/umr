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
import { parseGGUF } from "./gguf";
import { deriveContentDigest, deriveModelName, deriveModelRef } from "./naming";
import type { DataPaths } from "./paths";
import { emitInfo, emitSuccess, emitWarning } from "./progress";
import { Registry } from "./registry";
import { ModelStore } from "./store";
import type {
  CheckIssue,
  CheckResult,
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

export interface VirtualModelRegistryOptions {
  dataPaths: DataPaths;
  registry?: Registry;
  store?: ModelStore;
  sourceAdapters?: SourceAdapterRegistry;
  registrarAdapters?: RegistrarAdapterRegistry;
}

async function safeCleanup(resolvedSource: ResolvedSource): Promise<void> {
  await resolvedSource.cleanup?.();
}

async function buildManifest(
  members: SourceMember[],
): Promise<{ manifest: ModelManifestMember[]; totalSizeBytes: number }> {
  const manifest: ModelManifestMember[] = [];
  let totalSizeBytes = 0;

  for (const member of members) {
    const [sha256, sizeBytes] = await Promise.all([
      sha256File(member.sourcePath),
      fileSize(member.sourcePath),
    ]);
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

export class VirtualModelRegistry {
  readonly registry: Registry;
  readonly store: ModelStore;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly registrarAdapters: RegistrarAdapterRegistry;

  constructor(private readonly options: VirtualModelRegistryOptions) {
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
      await emitInfo(context?.reporter, "Hashing resolved model members");
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
        name: deriveModelName(resolved.entryRelPath, resolved.metadata),
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

  async register(
    client: string,
    selector: string,
    context?: OperationContext,
  ): Promise<RegistrationRecord> {
    const registrar = this.registrarAdapters.get(client);
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    await emitInfo(
      context?.reporter,
      `Registering ${model.name} with ${client}`,
    );
    const result = await registrar.register(model, context);
    const registration = this.registry.upsertRegistration(
      model.id,
      client,
      result.clientRef,
      result.state,
    );
    await emitSuccess(
      context?.reporter,
      `Registered ${model.name} with ${client} as ${registration.clientRef}`,
    );
    return registration;
  }

  async unregister(
    client: string,
    selector: string,
    context?: OperationContext,
  ): Promise<void> {
    const registrar = this.registrarAdapters.get(client);
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    const registration = this.registry.getRegistration(model.id, client);
    if (!registration) {
      throw new ManagerError(
        `Model ${selector} is not registered with ${client}`,
        {
          code: "missing-registration",
          exitCode: 2,
        },
      );
    }

    await emitInfo(
      context?.reporter,
      `Removing ${client} registration for ${model.name}`,
    );
    await registrar.unregister(model, registration, context);
    this.registry.deleteRegistration(model.id, client);
    await emitSuccess(
      context?.reporter,
      `Removed ${client} registration for ${model.name}`,
    );
  }

  async remove(selector: string, context?: OperationContext): Promise<void> {
    await emitInfo(context?.reporter, `Resolving model ${selector}`);
    const model = this.getModel(selector);
    if (model.registrations.length > 0) {
      throw new ManagerError(
        `Cannot remove ${selector} while client registrations exist`,
        {
          code: "model-still-registered",
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
    const models = this.registry.listModels();
    await emitInfo(
      options?.reporter,
      `Checking ${models.length} tracked model${models.length === 1 ? "" : "s"}`,
    );

    for (const model of models) {
      await emitInfo(
        options?.reporter,
        `Checking ${model.name} (${model.ref})`,
      );

      if (!(await pathExists(model.rootPath))) {
        issues.push({
          severity: "error",
          ref: model.ref,
          message: "missing-model-root",
        });
        continue;
      }

      if (!(await pathExists(model.entryPath))) {
        issues.push({
          severity: "error",
          ref: model.ref,
          message: "missing-entry-path",
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
            ref: model.ref,
            message: `missing-member:${member.relPath}`,
          });
          continue;
        }

        const actualSize = await fileSize(memberPath);
        if (actualSize !== member.sizeBytes) {
          issues.push({
            severity: "error",
            ref: model.ref,
            message: `member-size-mismatch:${member.relPath}`,
          });
        }
      }

      if (await pathExists(model.entryPath)) {
        try {
          await parseGGUF(model.entryPath);
        } catch (error) {
          issues.push({
            severity: "error",
            ref: model.ref,
            message: `invalid-gguf:${(error as Error).message}`,
          });
        }
      }

      const registrations = this.registry.listRegistrations(model.id);
      for (const registration of registrations) {
        const registrar = this.registrarAdapters.get(registration.client);
        const details = this.getModel(model.ref);
        const health = await registrar.check(details, registration, {
          reporter: options?.reporter,
        });
        if (!health.ok) {
          issues.push({
            severity: "warning",
            ref: model.ref,
            message: `${registration.client}:${health.issues.join(",")}`,
          });

          if (options?.fix) {
            this.registry.deleteRegistrationById(registration.id);
            await emitWarning(
              options?.reporter,
              `Cleared stale ${registration.client} registration for ${model.name}`,
            );
          }
        }
      }
    }

    let fixed = false;
    if (options?.fix) {
      fixed = true;
      await emitInfo(options?.reporter, "Cleaning stale temporary files");
      await this.cleanTempFiles();
      await emitInfo(options?.reporter, "Cleaning orphaned model roots");
      await this.cleanOrphanModelRoots();
      await emitSuccess(options?.reporter, "Finished safe repair pass");
    }

    return {
      ok:
        issues.filter((issue) => issue.severity === "error").length === 0 &&
        issues.length === 0,
      fixed,
      issues,
    };
  }

  private async cleanTempFiles(): Promise<void> {
    await this.store.cleanupOrphanTemps(24 * 60 * 60 * 1000);
  }

  private async cleanOrphanModelRoots(): Promise<void> {
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
      }
    }
  }
}
