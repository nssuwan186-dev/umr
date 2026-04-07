import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { parseGGUF } from "../src/gguf";
import { createTestGGUF } from "./helpers/gguf";

test("parseGGUF reads metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vmr-gguf-"));
  const filePath = path.join(dir, "tiny.gguf");
  await createTestGGUF(filePath, {
    "general.name": "Tiny Test Model",
    "tokenizer.ggml.model": "gpt2",
  });

  const summary = await parseGGUF(filePath);
  expect(summary.format).toBe("gguf");
  expect(summary.metadata["general.name"]).toBe("Tiny Test Model");
  expect(summary.metadata["tokenizer.ggml.model"]).toBe("gpt2");
});
