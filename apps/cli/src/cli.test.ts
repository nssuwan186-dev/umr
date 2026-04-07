import { expect, test } from "bun:test";

import { runCli } from "./cli";

function createFakeManager() {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const manager = {
    calls,
    listExplicitSourceKinds: () => ["hf"],
    addSource: async (
      kind: string,
      input: unknown,
      context?: { reporter?: { emit: (event: { message: string }) => void } },
    ) => {
      calls.push({ kind, input });
      context?.reporter?.emit({ message: "Resolving source" });
      context?.reporter?.emit({ message: "Hashing resolved model members" });
      return {
        status: "tracked" as const,
        model: {
          ref: "m_deadbeefdeadbeef",
          name: "tiny-model",
          contentDigest: "deadbeef",
          totalSizeBytes: 123,
          rootPath: "/tmp/model-root",
          entryRelPath: "tiny.gguf",
          entryPath: "/tmp/model-root/tiny.gguf",
          entryFilename: "tiny.gguf",
          format: "gguf" as const,
          metadata: {},
          manifest: [
            {
              relPath: "tiny.gguf",
              sha256: "deadbeef",
              sizeBytes: 123,
            },
          ],
          createdAt: 0,
          sources: [],
          registrations: [],
        },
      };
    },
    listModels: async () => [
      {
        ref: "m_deadbeefdeadbeef",
        name: "tiny-model",
        contentDigest: "deadbeef",
        totalSizeBytes: 123,
        rootPath: "/tmp/model-root",
        entryRelPath: "tiny.gguf",
        entryPath: "/tmp/model-root/tiny.gguf",
        entryFilename: "tiny.gguf",
        format: "gguf" as const,
        metadata: {},
        manifest: [
          {
            relPath: "tiny.gguf",
            sha256: "deadbeef",
            sizeBytes: 123,
          },
        ],
        createdAt: 0,
        registrations: ["lmstudio"],
        health: "ok" as const,
      },
    ],
    getModel: (_selector: string) => ({
      ref: "m_deadbeefdeadbeef",
      name: "tiny-model",
      contentDigest: "deadbeef",
      totalSizeBytes: 123,
      rootPath: "/tmp/model-root",
      entryRelPath: "tiny.gguf",
      entryPath: "/tmp/model-root/tiny.gguf",
      entryFilename: "tiny.gguf",
      format: "gguf" as const,
      metadata: {},
      manifest: [
        {
          relPath: "tiny.gguf",
          sha256: "deadbeef",
          sizeBytes: 123,
        },
      ],
      createdAt: 0,
      sources: [
        {
          id: "1",
          modelId: "1",
          kind: "path",
          payload: { originalPath: "/tmp/source.gguf" },
          createdAt: 0,
        },
      ],
      registrations: [
        {
          id: "2",
          modelId: "1",
          client: "lmstudio",
          clientRef: "/tmp/models/tiny.gguf",
          state: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }),
    register: async (client: string, ref: string) => ({
      clientRef: `${client}:${ref}`,
    }),
    unregister: async () => {},
    remove: async () => {},
    check: async () => ({ ok: true, fixed: false, issues: [] }),
  };

  return manager;
}

test("list prints a simple table", async () => {
  const lines: string[] = [];
  const code = await runCli(["list"], {
    manager: createFakeManager() as never,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(`ERR:${line}`),
  });

  expect(code).toBe(0);
  expect(lines).toEqual([
    "NAME                             REF                SIZE      REGS          HEALTH",
    "tiny-model                       m_deadbeefdeadbeef 123       lmstudio      ok",
  ]);
});

test("show --path prints only the model entry path", async () => {
  const lines: string[] = [];
  const code = await runCli(["show", "tiny-model", "--path"], {
    manager: createFakeManager() as never,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(`ERR:${line}`),
  });

  expect(code).toBe(0);
  expect(lines).toEqual(["/tmp/model-root/tiny.gguf"]);
});

test("add local path emits progress to stderr while keeping final output on stdout", async () => {
  const manager = createFakeManager();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const code = await runCli(["add", "/tmp/source.gguf"], {
    manager: manager as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
  });

  expect(code).toBe(0);
  expect(manager.calls).toEqual([
    { kind: "path", input: { path: "/tmp/source.gguf" } },
  ]);
  expect(stderrLines).toEqual([
    "-> Resolving source",
    "-> Hashing resolved model members",
  ]);
  expect(stdoutLines).toEqual([
    "tracked: tiny-model (m_deadbeefdeadbeef)",
    "/tmp/model-root/tiny.gguf",
  ]);
});

test("add hf dispatches to the explicit hf adapter", async () => {
  const manager = createFakeManager();
  const code = await runCli(
    [
      "add",
      "hf",
      "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
      "--file",
      "qwen2.5-0.5b-instruct-q2_k.gguf",
    ],
    {
      manager: manager as never,
      stdout: () => {},
      stderr: () => {},
    },
  );

  expect(code).toBe(0);
  expect(manager.calls).toEqual([
    {
      kind: "hf",
      input: {
        repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        file: "qwen2.5-0.5b-instruct-q2_k.gguf",
        revision: undefined,
      },
    },
  ]);
});

test("add ./hf is treated as a local path, not the hf source keyword", async () => {
  const manager = createFakeManager();
  const code = await runCli(["add", "./hf"], {
    manager: manager as never,
    stdout: () => {},
    stderr: () => {},
  });

  expect(code).toBe(0);
  expect(manager.calls).toEqual([{ kind: "path", input: { path: "./hf" } }]);
});
