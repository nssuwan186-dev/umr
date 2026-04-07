import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";
import { VirtualModelRegistry } from "../src/manager";
import { resolveDataPaths } from "../src/paths";
import { LMStudioRegistrarAdapter } from "../src/registrars/lmstudio";
import type { CommandResult, CommandRunner } from "../src/shell";
import { PathSourceAdapter } from "../src/sources/path-source";
import { createTestGGUF } from "./helpers/gguf";

function createLmsRunner(modelsDir: string): CommandRunner {
  return {
    async commandExists(command: string): Promise<boolean> {
      return command === "lms";
    },
    async run(command: string, args: string[] = []): Promise<CommandResult> {
      if (command !== "lms" || args[0] !== "import") {
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }

      const source = args[1];
      const userRepo = args[args.indexOf("--user-repo") + 1];
      const targetDir = path.join(modelsDir, userRepo);
      const targetPath = path.join(targetDir, path.basename(source));
      await mkdir(targetDir, { recursive: true });
      await Bun.write(targetPath, Bun.file(source));
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
}

function createVMR(
  dir: string,
  modelsDir: string,
  runner: CommandRunner,
): VirtualModelRegistry {
  const dataPaths = resolveDataPaths({
    VMR_HOME: path.join(dir, "home"),
  });
  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());
  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register(
    new LMStudioRegistrarAdapter(runner, dataPaths, {
      VMR_LMSTUDIO_MODELS_DIR: modelsDir,
      HOME: dir,
    }),
  );

  return new VirtualModelRegistry({
    dataPaths,
    sourceAdapters,
    registrarAdapters,
  });
}

test("lmstudio register and unregister manage a deterministic target path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-lms-"));
  const modelsDir = path.join(dir, "models");
  await mkdir(modelsDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const vmr = createVMR(dir, modelsDir, createLmsRunner(modelsDir));
  const added = await vmr.addSource("path", { path: sourcePath });
  const registration = await vmr.register("lmstudio", added.model.ref);
  expect(String(registration.state.targetPath)).toContain(
    path.join("vmr", "tiny"),
  );
  expect(
    await Bun.file(String(registration.state.targetPath)).exists(),
  ).toBeTrue();

  await vmr.unregister("lmstudio", added.model.ref);
  expect(
    await Bun.file(String(registration.state.targetPath)).exists(),
  ).toBeFalse();
});

test("lmstudio register prefers an HF-derived managed repo path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-lms-hf-"));
  const modelsDir = path.join(dir, "models");
  await mkdir(modelsDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const vmr = createVMR(dir, modelsDir, createLmsRunner(modelsDir));
  const added = await vmr.addSource("path", { path: sourcePath });
  vmr.registry.addSource(added.model.id, "hf", {
    repo: "afrideva/zephyr-smol_llama-100m-sft-full-GGUF",
    revision: "abc123",
    file: "zephyr-smol_llama-100m-sft-full.q2_k.gguf",
  });

  const registration = await vmr.register("lmstudio", added.model.ref);
  expect(String(registration.state.targetPath)).toContain(
    path.join("vmr", "zephyr-smol_llama-100m-sft-full-GGUF"),
  );
});

test("lmstudio register refreshes an existing managed target", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-lms-refresh-"));
  const modelsDir = path.join(dir, "models");
  await mkdir(modelsDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const vmr = createVMR(dir, modelsDir, createLmsRunner(modelsDir));
  const added = await vmr.addSource("path", { path: sourcePath });
  const first = await vmr.register("lmstudio", added.model.ref);
  await Bun.write(String(first.state.targetPath), "corrupt");

  const second = await vmr.register("lmstudio", added.model.ref);
  expect(second.clientRef).toBe(first.clientRef);
  expect(await Bun.file(String(second.state.targetPath)).text()).toContain(
    "GGUF",
  );
});

test("lmstudio unregister tolerates manual removal of the managed path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-lms-unreg-"));
  const modelsDir = path.join(dir, "models");
  await mkdir(modelsDir, { recursive: true });
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const vmr = createVMR(dir, modelsDir, createLmsRunner(modelsDir));
  const added = await vmr.addSource("path", { path: sourcePath });
  const registration = await vmr.register("lmstudio", added.model.ref);
  await rm(path.dirname(String(registration.state.targetPath)), {
    recursive: true,
    force: true,
  });

  await vmr.unregister("lmstudio", added.model.ref);
  expect(vmr.getModel(added.model.ref).registrations).toHaveLength(0);
});
