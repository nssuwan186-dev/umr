import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";
import { UnifiedModelRegistry } from "../src/manager";
import { resolveDataPaths } from "../src/paths";
import { JanRegistrarAdapter } from "../src/registrars/jan";
import { PathSourceAdapter } from "../src/sources/path-source";
import { createTestGGUF } from "./helpers/gguf";

function createVMR(dir: string, janDataDir: string): UnifiedModelRegistry {
  const dataPaths = resolveDataPaths({
    UMR_HOME: path.join(dir, "home"),
  });
  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());

  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register(
    new JanRegistrarAdapter({
      HOME: dir,
      UMR_JAN_DATA_DIR: janDataDir,
    }),
  );

  return new UnifiedModelRegistry({
    dataPaths,
    sourceAdapters,
    registrarAdapters,
  });
}

test("jan link writes model.yml pointing at the managed GGUF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-jan-"));
  const janDataDir = path.join(dir, "Jan", "data");
  await mkdir(janDataDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const umr = createVMR(dir, janDataDir);
  const added = await umr.addSource("path", { path: sourcePath });
  const registration = await umr.link("jan", added.model.ref);
  const configPath = String(registration.state.configPath);
  const entryMember = added.model.manifest.find(
    (member) => member.relPath === added.model.entryRelPath,
  );

  expect(entryMember).not.toBeUndefined();
  expect(await Bun.file(configPath).exists()).toBeTrue();
  const config = await Bun.file(configPath).text();
  expect(config).toContain(
    `model_path: ${JSON.stringify(added.model.entryPath)}`,
  );
  expect(config).toContain('name: "tiny"');
  expect(config).toContain(`size_bytes: ${entryMember?.sizeBytes}`);
  expect(config).toContain(`model_sha256: ${entryMember?.sha256}`);
});

test("jan unlink removes only Jan-managed metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-jan-unlink-"));
  const janDataDir = path.join(dir, "Jan", "data");
  await mkdir(janDataDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const umr = createVMR(dir, janDataDir);
  const added = await umr.addSource("path", { path: sourcePath });
  const registration = await umr.link("jan", added.model.ref);
  const configPath = String(registration.state.configPath);

  await umr.unlink("jan", added.model.ref);

  expect(await Bun.file(configPath).exists()).toBeFalse();
  expect(await Bun.file(added.model.entryPath).exists()).toBeTrue();
});
