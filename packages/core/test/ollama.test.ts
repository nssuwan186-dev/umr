import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";
import { UnifiedModelRegistry } from "../src/manager";
import { resolveDataPaths } from "../src/paths";
import { OllamaRegistrarAdapter } from "../src/registrars/ollama";
import type { CommandRunner } from "../src/shell";
import { PathSourceAdapter } from "../src/sources/path-source";
import { createTestGGUF } from "./helpers/gguf";

test("ollama link fails cleanly when Ollama is not installed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-ollama-missing-"));
  const sourcePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(sourcePath);

  const runner: CommandRunner = {
    async commandExists(command: string): Promise<boolean> {
      return command !== "ollama";
    },
    async run() {
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
    async runStreaming() {
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
  };

  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());
  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register(
    new OllamaRegistrarAdapter(
      runner,
      resolveDataPaths({
        UMR_HOME: path.join(dir, "home"),
      }),
    ),
  );

  const umr = new UnifiedModelRegistry({
    dataPaths: resolveDataPaths({
      UMR_HOME: path.join(dir, "home"),
    }),
    sourceAdapters,
    registrarAdapters,
  });
  const added = await umr.addSource("path", { path: sourcePath });

  await expect(umr.link("ollama", added.model.ref)).rejects.toHaveProperty(
    "message",
    "Ollama does not appear to be installed. Install Ollama, then try linking again.",
  );
});
