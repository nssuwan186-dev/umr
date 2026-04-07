import { mkdir, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";
import { VirtualModelRegistry } from "../src/manager";
import { resolveDataPaths } from "../src/paths";
import { PathSourceAdapter } from "../src/sources/path-source";
import { createTestGGUF } from "./helpers/gguf";

test("check --fix clears stale registrations, temp files, and orphaned model roots", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-check-"));
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());
  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register({
    client: () => "fake",
    register: async () => ({
      clientRef: "fake-ref",
      state: { targetPath: path.join(dir, "missing.gguf") },
    }),
    unregister: async () => {},
    check: async () => ({ ok: false, issues: ["missing"] }),
  });

  const dataPaths = resolveDataPaths({
    VMR_HOME: path.join(dir, "home"),
  });
  const vmr = new VirtualModelRegistry({
    dataPaths,
    sourceAdapters,
    registrarAdapters,
  });

  const added = await vmr.addSource("path", { path: sourcePath });
  await vmr.register("fake", added.model.ref);
  await mkdir(path.join(dataPaths.adaptersTmpDir, "ollama"), {
    recursive: true,
  });
  const stalePath = path.join(
    dataPaths.adaptersTmpDir,
    "ollama",
    "stale.Modelfile",
  );
  await Bun.write(stalePath, "FROM /tmp/nowhere\n");
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(stalePath, staleTime, staleTime);

  const orphanRoot = path.join(dataPaths.modelsDir, "orphan-digest");
  await mkdir(orphanRoot, { recursive: true });
  await Bun.write(path.join(orphanRoot, "orphan.gguf"), "GGUF");

  const result = await vmr.check({ fix: true });
  expect(result.fixed).toBeTrue();
  expect(vmr.getModel(added.model.ref).registrations).toHaveLength(0);
  expect(await Bun.file(stalePath).exists()).toBeFalse();
  expect(await Bun.file(orphanRoot).exists()).toBeFalse();
});
