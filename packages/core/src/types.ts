import path from "node:path";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ModelFormat = "gguf";

export type StoreStrategy = "copy" | "hardlink-or-copy";

export interface ProgressEvent {
  level: "info" | "success" | "warning";
  message: string;
}

export interface ProgressReporter {
  emit(event: ProgressEvent): void | Promise<void>;
}

export interface StreamSink {
  stdout?(chunk: string): void | Promise<void>;
  stderr?(chunk: string): void | Promise<void>;
}

export interface TransferProgressSink {
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

export interface OperationContext {
  reporter?: ProgressReporter;
  streamSink?: StreamSink;
  transferProgress?: TransferProgressSink;
}

export interface SourceDescriptor {
  kind: string;
  payload: Record<string, JsonValue>;
}

export interface SourceMember {
  sourcePath: string;
  relPath: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface ModelManifestMember {
  relPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ResolvedSource {
  format: ModelFormat;
  metadata: Record<string, JsonValue>;
  provenance: Record<string, JsonValue>;
  storeStrategy: StoreStrategy;
  entryRelPath: string;
  members: SourceMember[];
  cleanup?: (() => Promise<void>) | (() => void);
}

export interface SourceAdapter<TInput = unknown> {
  kind(): string;
  describe(input: TInput): SourceDescriptor;
  resolve(input: TInput, context?: OperationContext): Promise<ResolvedSource>;
}

export interface RegistrationHealth {
  ok: boolean;
  issues: string[];
}

export interface RegistrationResult {
  clientRef: string;
  state: Record<string, JsonValue>;
}

export interface RegistrarAdapter {
  client(): string;
  register(
    model: ModelDetails,
    context?: OperationContext,
  ): Promise<RegistrationResult>;
  unregister(
    model: ModelDetails,
    registration: RegistrationRecord,
    context?: OperationContext,
  ): Promise<void>;
  check(
    model: ModelDetails,
    registration: RegistrationRecord,
    context?: OperationContext,
  ): Promise<RegistrationHealth>;
}

export interface ModelRecord {
  id: string;
  ref: string;
  name: string;
  contentDigest: string;
  totalSizeBytes: number;
  rootPath: string;
  entryRelPath: string;
  entryPath: string;
  entryFilename: string;
  format: ModelFormat;
  metadata: Record<string, JsonValue>;
  manifest: ModelManifestMember[];
  createdAt: number;
}

export interface SourceRecord {
  id: string;
  modelId: string;
  kind: string;
  payload: Record<string, JsonValue>;
  createdAt: number;
}

export interface RegistrationRecord {
  id: string;
  modelId: string;
  client: string;
  clientRef: string;
  state: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
}

export interface ModelDetails extends ModelRecord {
  sources: SourceRecord[];
  registrations: RegistrationRecord[];
}

export interface CheckIssue {
  severity: "error" | "warning";
  ref?: string;
  code: string;
  fixable: boolean;
}

export interface CheckRepair {
  ref?: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  fixed: boolean;
  checkedModels: number;
  issues: CheckIssue[];
  repairs: CheckRepair[];
}

export function resolveModelEntryPath(
  rootPath: string,
  entryRelPath: string,
): string {
  return path.join(rootPath, entryRelPath);
}

export function resolveModelEntryFilename(entryRelPath: string): string {
  return path.basename(entryRelPath);
}
