import { expect, test } from "bun:test";

import { runCli } from "./cli";

function createModel(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function createFakeManager(options?: {
  trackedHFSource?: ReturnType<typeof createModel> | null;
  trackedHFFile?: string;
  inspectGGUFFiles?: string[];
  cachedHFFiles?: string[];
}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const model = createModel();
  const manager = {
    calls,
    listExplicitSourceKinds: () => ["hf"],
    inspectHFSource: async ({
      repo,
    }: {
      repo: string;
      revision?: string;
    }) => ({
      repo,
      resolvedRevision: "resolved-sha",
      ggufFiles: options?.inspectGGUFFiles ?? ["tiny-q4.gguf", "tiny-q8.gguf"],
      cachedFiles: options?.cachedHFFiles ?? [],
    }),
    findTrackedSource: (_kind: string, payload: unknown) => {
      if (!options?.trackedHFSource) {
        return null;
      }

      if (!options.trackedHFFile) {
        return options.trackedHFSource;
      }

      const file =
        typeof payload === "object" &&
        payload !== null &&
        "file" in payload &&
        typeof payload.file === "string"
          ? payload.file
          : undefined;
      return file === options.trackedHFFile ? options.trackedHFSource : null;
    },
    addSource: async (
      kind: string,
      input: unknown,
      context?: {
        reporter?: { emit: (event: { message: string }) => void };
        streamSink?: { stderr?: (chunk: string) => void };
      },
    ) => {
      calls.push({ kind, input });
      context?.reporter?.emit({ message: "Resolving source" });
      context?.reporter?.emit({ message: "Hashing resolved model members" });
      if (kind === "hf") {
        context?.streamSink?.stderr?.("hf-progress");
      }
      return {
        status: "tracked" as const,
        model,
      };
    },
    listModels: async () => [
      {
        ...model,
        registrations: ["lmstudio"],
        health: "ok" as const,
      },
    ],
    getModel: (_selector: string) => ({
      ...model,
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
    "NAME                             SIZE      REGS          HEALTH",
    "tiny-model                       123       lmstudio      ok",
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

test("add local path stays quiet by default while keeping final output on stdout", async () => {
  const manager = createFakeManager();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const code = await runCli(["add", "/tmp/source.gguf"], {
    manager: manager as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(manager.calls).toEqual([
    { kind: "path", input: { path: "/tmp/source.gguf" } },
  ]);
  expect(stderrLines).toEqual([]);
  expect(stdoutLines).toEqual([
    "tracked: tiny-model",
    "/tmp/model-root/tiny.gguf",
  ]);
});

test("add local path emits reporter lines with --verbose", async () => {
  const manager = createFakeManager();
  const stderrLines: string[] = [];
  const code = await runCli(["--verbose", "add", "/tmp/source.gguf"], {
    manager: manager as never,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stderrLines).toEqual([
    "-> Resolving source",
    "-> Hashing resolved model members",
  ]);
});

test("add hf with --file and --yes dispatches to the explicit hf adapter", async () => {
  const manager = createFakeManager({ inspectGGUFFiles: ["tiny-q2.gguf"] });
  const stderrRaw: string[] = [];
  const code = await runCli(
    [
      "add",
      "hf",
      "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
      "--file",
      "tiny-q2.gguf",
      "--yes",
    ],
    {
      manager: manager as never,
      stdout: () => {},
      stderr: () => {},
      stderrRaw: (chunk) => stderrRaw.push(chunk),
    },
  );

  expect(code).toBe(0);
  expect(manager.calls).toEqual([
    {
      kind: "hf",
      input: {
        repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        file: "tiny-q2.gguf",
        revision: "resolved-sha",
      },
    },
  ]);
  expect(stderrRaw).toContain("hf-progress");
});

test("add hf prompts to choose a GGUF file in interactive mode", async () => {
  const manager = createFakeManager();
  let selectInput:
    | {
        message: string;
        options: Array<{ value: string; label: string; hint?: string }>;
      }
    | undefined;
  const prompts = {
    confirm: async () => true,
    select: async (input: {
      message: string;
      options: Array<{ value: string; label: string; hint?: string }>;
    }) => {
      selectInput = input;
      return "tiny-q8.gguf";
    },
  };

  const code = await runCli(["add", "hf", "repo/name"], {
    manager: manager as never,
    interactive: true,
    prompts,
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(manager.calls).toEqual([
    {
      kind: "hf",
      input: {
        repo: "repo/name",
        file: "tiny-q8.gguf",
        revision: "resolved-sha",
      },
    },
  ]);
  expect(selectInput?.message).toBe("Choose a GGUF file");
  expect(selectInput?.options).toEqual([
    {
      value: "tiny-q4.gguf",
      label: "tiny-q4.gguf",
      hint: "Download Required",
    },
    {
      value: "tiny-q8.gguf",
      label: "tiny-q8.gguf",
      hint: "Download Required",
    },
  ]);
});

test("add hf without --file fails in non-interactive mode and lists files", async () => {
  const stderrLines: string[] = [];
  const code = await runCli(["add", "hf", "repo/name"], {
    manager: createFakeManager() as never,
    interactive: false,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(2);
  expect(stderrLines.at(-1)).toContain(
    "Multiple GGUF files found in repo/name",
  );
  expect(stderrLines.at(-1)).toContain("tiny-q4.gguf");
  expect(stderrLines.at(-1)).toContain("tiny-q8.gguf");
  expect(stderrLines.at(-1)).toContain("Download Required");
});

test("add hf without --yes fails in non-interactive mode", async () => {
  const stderrLines: string[] = [];
  const code = await runCli(
    ["add", "hf", "repo/name", "--file", "tiny-q4.gguf"],
    {
      manager: createFakeManager() as never,
      interactive: false,
      stdout: () => {},
      stderr: (line) => stderrLines.push(line),
      stdoutRaw: () => {},
      stderrRaw: () => {},
    },
  );

  expect(code).toBe(2);
  expect(stderrLines.at(-1)).toContain("rerun with --yes");
});

test("existing tracked hf source skips confirmation and add", async () => {
  const trackedHFSource = createModel({
    name: "existing-model",
    entryPath: "/tmp/existing-model/tiny.gguf",
  });
  let confirmCalls = 0;
  const prompts = {
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
    select: async () => "tiny-q4.gguf",
  };
  const stdoutLines: string[] = [];
  const manager = createFakeManager({ trackedHFSource });

  const code = await runCli(["add", "hf", "repo/name"], {
    manager: manager as never,
    interactive: true,
    prompts,
    stdout: (line) => stdoutLines.push(line),
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(confirmCalls).toBe(0);
  expect(manager.calls).toEqual([]);
  expect(stdoutLines).toEqual([
    "existing: existing-model",
    "/tmp/existing-model/tiny.gguf",
  ]);
});

test("cached hf file skips confirmation and adds immediately", async () => {
  const manager = createFakeManager({
    inspectGGUFFiles: ["tiny-q4.gguf"],
    cachedHFFiles: ["tiny-q4.gguf"],
  });
  let confirmCalls = 0;
  const code = await runCli(["add", "hf", "repo/name"], {
    manager: manager as never,
    interactive: true,
    prompts: {
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      select: async () => "tiny-q4.gguf",
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(confirmCalls).toBe(0);
  expect(manager.calls).toEqual([
    {
      kind: "hf",
      input: {
        repo: "repo/name",
        file: "tiny-q4.gguf",
        revision: "resolved-sha",
      },
    },
  ]);
});

test("hf chooser annotates tracked and cached options", async () => {
  const trackedHFSource = createModel({
    name: "tracked-model",
    entryPath: "/tmp/tracked-model/tiny-q4.gguf",
  });
  const manager = createFakeManager({
    trackedHFSource,
    trackedHFFile: "tiny-q4.gguf",
    inspectGGUFFiles: ["tiny-q4.gguf", "tiny-q8.gguf"],
    cachedHFFiles: ["tiny-q8.gguf"],
  });
  let selectInput:
    | {
        message: string;
        options: Array<{ value: string; label: string; hint?: string }>;
      }
    | undefined;

  const code = await runCli(["add", "hf", "repo/name"], {
    manager: manager as never,
    interactive: true,
    prompts: {
      confirm: async () => true,
      select: async (input: {
        message: string;
        options: Array<{ value: string; label: string; hint?: string }>;
      }) => {
        selectInput = input;
        return "tiny-q8.gguf";
      },
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(selectInput?.options).toEqual([
    {
      value: "tiny-q4.gguf",
      label: "tiny-q4.gguf",
      hint: "Already Added to VMR",
    },
    {
      value: "tiny-q8.gguf",
      label: "tiny-q8.gguf",
      hint: "Available Locally in HF",
    },
  ]);
});

test("add ./hf is treated as a local path, not the hf source keyword", async () => {
  const manager = createFakeManager();
  const code = await runCli(["add", "./hf"], {
    manager: manager as never,
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(manager.calls).toEqual([{ kind: "path", input: { path: "./hf" } }]);
});

test("missing command args surface a clean commander error", async () => {
  const stderrRaw: string[] = [];
  const code = await runCli(["show"], {
    manager: createFakeManager() as never,
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: (chunk) => stderrRaw.push(chunk),
  });

  expect(code).toBe(1);
  expect(stderrRaw.join("")).toContain("missing required argument 'model'");
});

test("no args prints help", async () => {
  const stdoutRaw: string[] = [];
  const code = await runCli([], {
    manager: createFakeManager() as never,
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stdoutRaw.join("")).toContain("Usage: vmr");
});
