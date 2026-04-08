import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { createDefaultUMR } from "../src/defaults";

const shouldRun = process.env.UMR_RUN_E2E === "1";

test.if(shouldRun)("e2e add hf with a small qwen gguf", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "umr-e2e-"));
  const umr = createDefaultUMR({
    ...process.env,
    UMR_HOME: path.join(dir, "home"),
  });
  const added = await umr.addSource("hf", {
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file: "qwen2.5-0.5b-instruct-q2_k.gguf",
  });

  expect(added.model.ref.startsWith("m_")).toBeTrue();
  expect(await Bun.file(added.model.entryPath).exists()).toBeTrue();
  expect(added.model.rootPath).toContain(path.join("home", "models"));
});
