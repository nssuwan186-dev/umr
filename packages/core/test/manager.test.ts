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

test("generic adapters plug into add/register/remove flow for multi-member models", async () => {
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

  expect(first.model.name).toBe("active");
  expect(second.model.name).toBe("active-2");
  expect(umr.getModel("active").entryPath).toBe(first.model.entryPath);
  expect(umr.getModel("active-2").entryPath).toBe(second.model.entryPath);
});
