import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";
import { UnifiedModelRegistry } from "../src/manager";
import { resolveDataPaths } from "../src/paths";
import { PathSourceAdapter } from "../src/sources/path-source";
import { createTestGGUF } from "./helpers/gguf";

function createVMR(root: string) {
  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());

  const registrarAdapters = new RegistrarAdapterRegistry();

  return new UnifiedModelRegistry({
    dataPaths: resolveDataPaths({ UMR_HOME: root }),
    sourceAdapters,
    registrarAdapters,
  });
}

test("add path copies into managed model root and survives source move", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-manager-"));
  const sourceDir = path.join(dir, "source");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const umr = createVMR(path.join(dir, "home"));
  const added = await umr.addSource("path", { path: sourcePath });

  expect(added.model.entryPath).not.toBe(sourcePath);
  expect(added.model.rootPath).toContain(path.join("home", "models"));
  await rename(sourcePath, path.join(sourceDir, "moved.gguf"));

  const model = umr.getModel(added.model.ref);
  expect(model.entryPath).toBe(added.model.entryPath);
  expect(await Bun.file(model.entryPath).text()).toContain("GGUF");
  expect(umr.getModel(added.model.name).ref).toBe(added.model.ref);
});

test("add path emits transfer progress while copying into UMR storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-copy-progress-"));
  const sourceDir = path.join(dir, "source");
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const events: string[] = [];
  const umr = createVMR(path.join(dir, "home"));
  await umr.addSource(
    "path",
    { path: sourcePath },
    {
      transferProgress: {
        start(task) {
          events.push(`start:${task.label}:${task.totalBytes}`);
        },
        update(task) {
          events.push(`update:${task.label}:${task.completedBytes}`);
        },
        finish(task) {
          events.push(`finish:${task.label}:${task.totalBytes}`);
        },
      },
    },
  );

  expect(events.some((event) => event.startsWith("start:tiny.gguf:"))).toBe(
    true,
  );
  expect(events.some((event) => event.startsWith("update:tiny.gguf:"))).toBe(
    true,
  );
  expect(events.some((event) => event.startsWith("finish:tiny.gguf:"))).toBe(
    true,
  );
});

test("generic adapters plug into add/link/remove flow for multi-member models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-generic-"));
  const entryPath = path.join(dir, "fake.gguf");
  const auxPath = path.join(dir, "config.json");
  await createTestGGUF(entryPath);
  await Bun.write(auxPath, '{"hello":"world"}');

  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register({
    kind: () => "memory",
    describe: () => ({ kind: "memory", payload: { source: "memory" } }),
    resolve: async () => ({
      format: "gguf" as const,
      metadata: { "general.name": "Memory Model" },
      provenance: { source: "memory" },
      storeStrategy: "copy" as const,
      entryRelPath: "fake.gguf",
      members: [
        { sourcePath: entryPath, relPath: "fake.gguf" },
        { sourcePath: auxPath, relPath: "config/config.json" },
      ],
    }),
  });

  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register({
    client: () => "fake",
    register: async (model: { ref: string; entryPath: string }) => ({
      clientRef: `fake-${model.ref}`,
      state: { ok: true, path: model.entryPath },
    }),
    unregister: async () => {},
    check: async () => ({ ok: true, issues: [] }),
  });

  const umr = new UnifiedModelRegistry({
    dataPaths: resolveDataPaths({
      UMR_HOME: path.join(dir, "home"),
    }),
    sourceAdapters,
    registrarAdapters,
  });

  const added = await umr.addSource("memory", {});
  expect(added.model.manifest).toHaveLength(2);
  expect(
    await Bun.file(
      path.join(added.model.rootPath, "config", "config.json"),
    ).text(),
  ).toBe('{"hello":"world"}');
  const registration = await umr.link("fake", added.model.ref);
  expect(registration.clientRef).toContain(added.model.ref);
  await umr.unlink("fake", added.model.ref);
  await umr.remove(added.model.ref);
  expect(await umr.listModels()).toHaveLength(0);
});

test("model names are made unique when the base name collides", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-name-collision-"));
  const sourceDir = path.join(dir, "source");
  await mkdir(sourceDir, { recursive: true });
  const firstSourcePath = path.join(sourceDir, "first-q4.gguf");
  const secondSourcePath = path.join(sourceDir, "second-q8.gguf");
  await createTestGGUF(firstSourcePath, { "general.name": "Active" });
  await createTestGGUF(secondSourcePath, { "general.name": "Active" });

  const umr = createVMR(path.join(dir, "home"));
  const first = await umr.addSource("path", { path: firstSourcePath });
  const second = await umr.addSource("path", { path: secondSourcePath });

  expect(first.model.name).toBe("first-q4");
  expect(second.model.name).toBe("second-q8");
  expect(umr.getModel("first-q4").entryPath).toBe(first.model.entryPath);
  expect(umr.getModel("second-q8").entryPath).toBe(second.model.entryPath);
});

test("local path imports derive the model name from the selected filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-local-name-"));
  const sourcePath = path.join(
    dir,
    "zephyr-smol_llama-100m-sft-full.q2_k.gguf",
  );
  await createTestGGUF(sourcePath, { "general.name": "Active" });

  const umr = createVMR(path.join(dir, "home"));
  const added = await umr.addSource("path", { path: sourcePath });

  expect(added.model.name).toBe("zephyr-smol-llama-100m-sft-full-q2-k");
});

test("hf-style imports derive the model name from the selected filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-hf-name-"));
  const sourcePath = path.join(dir, "gemma-4-e2b-it-Q8_0.gguf");
  await createTestGGUF(sourcePath, { "general.name": "Ignored Name" });

  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register({
    kind: () => "hf",
    describe: () => ({
      kind: "hf",
      payload: {
        repo: "ggml-org/gemma-4-E2B-it-GGUF",
        file: "gemma-4-e2b-it-Q8_0.gguf",
        revision: "abc123",
      },
    }),
    resolve: async () => ({
      format: "gguf" as const,
      metadata: {},
      provenance: {
        repo: "ggml-org/gemma-4-E2B-it-GGUF",
        file: "gemma-4-e2b-it-Q8_0.gguf",
        revision: "abc123",
      },
      storeStrategy: "copy" as const,
      entryRelPath: "gemma-4-e2b-it-Q8_0.gguf",
      members: [
        {
          sourcePath,
          relPath: "gemma-4-e2b-it-Q8_0.gguf",
        },
      ],
    }),
  });

  const umr = new UnifiedModelRegistry({
    dataPaths: resolveDataPaths({
      UMR_HOME: path.join(dir, "home"),
    }),
    sourceAdapters,
    registrarAdapters: new RegistrarAdapterRegistry(),
  });

  const added = await umr.addSource("hf", {
    repo: "ggml-org/gemma-4-E2B-it-GGUF",
    file: "gemma-4-e2b-it-Q8_0.gguf",
  });

  expect(added.model.name).toBe("gemma-4-e2b-it-q8-0");
});
