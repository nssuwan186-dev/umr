import { mkdirSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { DataPaths } from "./paths";
import type {
  JsonValue,
  ModelDetails,
  ModelManifestMember,
  ModelRecord,
  RegistrationRecord,
  SourceRecord,
} from "./types";
import { resolveModelEntryFilename, resolveModelEntryPath } from "./types";

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function rowToModel(row: Record<string, unknown>): ModelRecord {
  const rootPath = row.root_path as string;
  const entryRelPath = row.entry_rel_path as string;
  return {
    id: row.id as string,
    ref: row.ref as string,
    name: row.name as string,
    contentDigest: row.content_digest as string,
    totalSizeBytes: row.total_size_bytes as number,
    rootPath,
    entryRelPath,
    entryPath: resolveModelEntryPath(rootPath, entryRelPath),
    entryFilename: resolveModelEntryFilename(entryRelPath),
    format: row.format as "gguf",
    metadata: parseJson<Record<string, JsonValue>>(row.metadata_json as string),
    manifest: parseJson<ModelManifestMember[]>(row.manifest_json as string),
    createdAt: row.created_at as number,
  };
}

function rowToSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: row.id as string,
    modelId: row.model_id as string,
    kind: row.kind as string,
    payload: parseJson<Record<string, JsonValue>>(row.payload_json as string),
    createdAt: row.created_at as number,
  };
}

function rowToRegistration(row: Record<string, unknown>): RegistrationRecord {
  return {
    id: row.id as string,
    modelId: row.model_id as string,
    client: row.client as string,
    clientRef: row.client_ref as string,
    state: parseJson<Record<string, JsonValue>>(row.state_json as string),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export class Registry {
  readonly db: Database;

  constructor(paths: DataPaths) {
    mkdirSync(path.dirname(paths.registryPath), { recursive: true });
    this.db = new Database(paths.registryPath, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        content_digest TEXT NOT NULL UNIQUE,
        total_size_bytes INTEGER NOT NULL,
        root_path TEXT NOT NULL,
        entry_rel_path TEXT NOT NULL,
        format TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registrations (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        client TEXT NOT NULL,
        client_ref TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(model_id, client)
      );
    `);
  }

  listModels(): ModelRecord[] {
    return this.db
      .query("SELECT * FROM models ORDER BY name ASC, ref ASC")
      .all()
      .map((row) => rowToModel(row as Record<string, unknown>));
  }

  getModelByRef(ref: string): ModelRecord | null {
    const row = this.db.query("SELECT * FROM models WHERE ref = ?").get(ref);
    return row ? rowToModel(row as Record<string, unknown>) : null;
  }

  listModelsByName(name: string): ModelRecord[] {
    return this.db
      .query("SELECT * FROM models WHERE name = ? ORDER BY ref ASC")
      .all(name)
      .map((row) => rowToModel(row as Record<string, unknown>));
  }

  isNameTaken(name: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM models WHERE name = ? LIMIT 1")
      .get(name);
  }

  getModelByContentDigest(contentDigest: string): ModelRecord | null {
    const row = this.db
      .query("SELECT * FROM models WHERE content_digest = ?")
      .get(contentDigest);
    return row ? rowToModel(row as Record<string, unknown>) : null;
  }

  findModelBySource(
    kind: string,
    payload: Record<string, JsonValue>,
  ): ModelRecord | null {
    const row = this.db
      .query(
        `SELECT models.*
         FROM models
         JOIN sources ON sources.model_id = models.id
         WHERE sources.kind = ? AND sources.payload_json = ?
         LIMIT 1`,
      )
      .get(kind, JSON.stringify(payload));
    return row ? rowToModel(row as Record<string, unknown>) : null;
  }

  isRefTaken(ref: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM models WHERE ref = ? LIMIT 1")
      .get(ref);
  }

  createModel(
    input: Omit<ModelRecord, "id" | "entryPath" | "entryFilename">,
  ): ModelRecord {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO models (
          id, ref, name, content_digest, total_size_bytes, root_path, entry_rel_path, format, metadata_json, manifest_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ref,
        input.name,
        input.contentDigest,
        input.totalSizeBytes,
        input.rootPath,
        input.entryRelPath,
        input.format,
        JSON.stringify(input.metadata),
        JSON.stringify(input.manifest),
        input.createdAt,
      );

    return rowToModel({
      id,
      ref: input.ref,
      name: input.name,
      content_digest: input.contentDigest,
      total_size_bytes: input.totalSizeBytes,
      root_path: input.rootPath,
      entry_rel_path: input.entryRelPath,
      format: input.format,
      metadata_json: JSON.stringify(input.metadata),
      manifest_json: JSON.stringify(input.manifest),
      created_at: input.createdAt,
    });
  }

  addSource(
    modelId: string,
    kind: string,
    payload: Record<string, JsonValue>,
  ): SourceRecord {
    const payloadJson = JSON.stringify(payload);
    const existing = this.db
      .query(
        "SELECT * FROM sources WHERE model_id = ? AND kind = ? AND payload_json = ? LIMIT 1",
      )
      .get(modelId, kind, payloadJson);

    if (existing) {
      return rowToSource(existing as Record<string, unknown>);
    }

    const record: SourceRecord = {
      id: crypto.randomUUID(),
      modelId,
      kind,
      payload,
      createdAt: Date.now(),
    };

    this.db
      .query(
        "INSERT INTO sources (id, model_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.modelId,
        record.kind,
        payloadJson,
        record.createdAt,
      );

    return record;
  }

  listSources(modelId: string): SourceRecord[] {
    return this.db
      .query("SELECT * FROM sources WHERE model_id = ? ORDER BY created_at ASC")
      .all(modelId)
      .map((row) => rowToSource(row as Record<string, unknown>));
  }

  upsertRegistration(
    modelId: string,
    client: string,
    clientRef: string,
    state: Record<string, JsonValue>,
  ): RegistrationRecord {
    const now = Date.now();
    const stateJson = JSON.stringify(state);
    const existing = this.db
      .query("SELECT * FROM registrations WHERE model_id = ? AND client = ?")
      .get(modelId, client);
    if (existing) {
      const record = rowToRegistration(existing as Record<string, unknown>);
      this.db
        .query(
          "UPDATE registrations SET client_ref = ?, state_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(clientRef, stateJson, now, record.id);

      return {
        ...record,
        clientRef,
        state,
        updatedAt: now,
      };
    }

    const record: RegistrationRecord = {
      id: crypto.randomUUID(),
      modelId,
      client,
      clientRef,
      state,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .query(
        "INSERT INTO registrations (id, model_id, client, client_ref, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.modelId,
        record.client,
        record.clientRef,
        stateJson,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  getRegistration(modelId: string, client: string): RegistrationRecord | null {
    const row = this.db
      .query("SELECT * FROM registrations WHERE model_id = ? AND client = ?")
      .get(modelId, client);
    return row ? rowToRegistration(row as Record<string, unknown>) : null;
  }

  listRegistrations(modelId: string): RegistrationRecord[] {
    return this.db
      .query(
        "SELECT * FROM registrations WHERE model_id = ? ORDER BY client ASC",
      )
      .all(modelId)
      .map((row) => rowToRegistration(row as Record<string, unknown>));
  }

  deleteRegistration(modelId: string, client: string): void {
    this.db
      .query("DELETE FROM registrations WHERE model_id = ? AND client = ?")
      .run(modelId, client);
  }

  deleteRegistrationById(id: string): void {
    this.db.query("DELETE FROM registrations WHERE id = ?").run(id);
  }

  deleteModel(modelId: string): void {
    this.db.query("DELETE FROM models WHERE id = ?").run(modelId);
  }

  getModelDetails(ref: string): ModelDetails | null {
    const model = this.getModelByRef(ref);
    if (!model) {
      return null;
    }

    return {
      ...model,
      sources: this.listSources(model.id),
      registrations: this.listRegistrations(model.id),
    };
  }
}
