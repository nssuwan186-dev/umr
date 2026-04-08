import { expect, test } from "bun:test";

import { type CheckResult, ManagerError } from "@umr/core";

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
    registrations: [] as Array<{
      id: string;
      modelId: string;
      client: string;
      clientRef: string;
      state: Record<string, unknown>;
      createdAt: number;
      updatedAt: number;
    }>,
    ...overrides,
  };
}

function createFakeManager(options?: {
  trackedHFSource?: ReturnType<typeof createModel> | null;
  trackedHFFile?: string;
  inspectGGUFFiles?: string[];
  cachedHFFiles?: string[];
  listRows?: Array<{
    name: string;
    sourceKind: string;
    format: "gguf";
    totalSizeBytes: number;
    registrations: string[];
    health: "ok" | "missing";
  }>;
  model?: ReturnType<typeof createModel>;
  checkResult?: CheckResult;
}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const model = options?.model ?? createModel();
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
        reporter?: {
          emit: (event: { message: string; level?: string }) => void;
        };
        streamSink?: { stderr?: (chunk: string) => void };
      },
    ) => {
      calls.push({ kind, input });
      context?.reporter?.emit({ message: "Resolving source", level: "info" });
      context?.reporter?.emit({
        message: "Hashing resolved model members",
        level: "info",
      });
      if (kind === "hf") {
        context?.streamSink?.stderr?.("hf-progress");
      }
      return {
        status: "tracked" as const,
        model,
      };
    },
    listModels: async () =>
      options?.listRows ?? [
        {
          ...model,
          sourceKind: "local",
          registrations: ["lmstudio"],
          health: "ok" as const,
        },
      ],
    getModel: (_selector: string) => ({
      ...model,
      sources: options?.model
        ? model.sources
        : [
            {
              id: "1",
              modelId: "1",
              kind: "path",
              payload: { originalPath: "/tmp/source.gguf" },
              createdAt: 0,
            },
          ],
      registrations: options?.model
        ? model.registrations
        : [
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
    link: async (client: string, ref: string) => ({
      clientRef: `${client}:${ref}`,
    }),
    unlink: async () => {},
    remove: async (selector: string) => {
      const currentModel =
        selector === model.ref || selector === model.name
          ? model
          : createModel();
      if (currentModel.registrations.length > 0) {
        const unlinkCommands = currentModel.registrations
          .map(
            (registration) =>
              `  umr unlink ${registration.client} ${currentModel.name}`,
          )
          .join("\n");
        throw new ManagerError(
          `Cannot remove model ${currentModel.name} while links exist.\n\nUnlink it first:\n${unlinkCommands}`,
          {
            code: "model-still-linked",
            exitCode: 2,
          },
        );
      }
    },
    check: async () =>
      options?.checkResult ?? {
        ok: true,
        fixed: false,
        checkedModels: 1,
        issues: [],
        repairs: [],
      },
  };

  return manager;
}

test("root help uses custom text and does not initialize the manager", async () => {
  const stdoutRaw: string[] = [];
  let createManagerCalls = 0;

  const code = await runCli(["--help"], {
    createManager: () => {
      createManagerCalls += 1;
      throw new Error("manager should not be created");
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(createManagerCalls).toBe(0);
  expect(
    stdoutRaw.join(""),
  ).toBe(`UMR is the unified model registry for your local AI apps. (v0.1.0)

Usage: umr <command> [...flags] [...args]

Commands:
  add        <source>          Add a model to UMR
             hf <repo>         Add a model from Hugging Face
             <path>            Add a local model

  link       <client> <model>  Link a model to a client app
             lmstudio <model>  Link model to LM Studio
             ollama <model>    Link model to Ollama
             jan <model>       Link model to Jan
             --help            See full list
  unlink     <client> <model>  Remove a model link from a client app

  list                         List tracked models
  show       <model>           Show model details
  remove     <model>           Remove a model from UMR
  check                        Check UMR state and client links

  <command>  --help            Print help text for command

Flags:
  --verbose  Show detailed progress
  --version  Print version
  --help     Print help
`);
});

test("add help uses custom text and does not initialize the manager", async () => {
  const stdoutRaw: string[] = [];
  let createManagerCalls = 0;

  const code = await runCli(["add", "--help"], {
    createManager: () => {
      createManagerCalls += 1;
      throw new Error("manager should not be created");
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(createManagerCalls).toBe(0);
  expect(stdoutRaw.join("")).toBe(`Usage: umr add <path>
       umr add hf <repo> [--file <name>] [--revision <rev>] [--yes]

Add a model from a local path or Hugging Face.

Flags:
  --file <name>     Choose a GGUF file from the repo
  --revision <rev>  Resolve a branch, tag, or commit
  -y, --yes         Skip download confirmation
  -h, --help        Print help

Sources:
  <path>  Local file or directory
  hf      Hugging Face repo
`);
});

test("link help uses custom text and does not initialize the manager", async () => {
  const stdoutRaw: string[] = [];
  let createManagerCalls = 0;

  const code = await runCli(["link", "--help"], {
    createManager: () => {
      createManagerCalls += 1;
      throw new Error("manager should not be created");
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(createManagerCalls).toBe(0);
  expect(stdoutRaw.join("")).toBe(`Usage: umr link <client> <model>

Link a model to a client app.

Flags:
  -h, --help  Print help

Clients:
  lmstudio  LM Studio
  ollama    Ollama
  jan       Jan
`);
});

test("show help uses custom text and does not initialize the manager", async () => {
  const stdoutRaw: string[] = [];
  let createManagerCalls = 0;

  const code = await runCli(["show", "--help"], {
    createManager: () => {
      createManagerCalls += 1;
      throw new Error("manager should not be created");
    },
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(createManagerCalls).toBe(0);
  expect(stdoutRaw.join("")).toBe(`Usage: umr show <model> [--path]

Show details for a tracked model.

Flags:
  --path  Print only the model entry path
  --help  Print help
`);
});

test("unknown command help falls back to the custom root help", async () => {
  const stdoutRaw: string[] = [];

  const code = await runCli(["nonexistentcommand", "--help"], {
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stdoutRaw.join("")).toContain(
    "UMR is the unified model registry for your local AI apps. (v0.1.0)",
  );
  expect(stdoutRaw.join("")).not.toContain("Usage: umr [options] [command]");
});

test("unknown command prints only the custom root help", async () => {
  const stdoutRaw: string[] = [];
  const stderrRaw: string[] = [];

  const code = await runCli(["nonexistentcommand"], {
    stdout: () => {},
    stderr: () => {},
    stdoutRaw: (chunk) => stdoutRaw.push(chunk),
    stderrRaw: (chunk) => stderrRaw.push(chunk),
  });

  expect(code).toBe(1);
  expect(stdoutRaw.join("")).toContain(
    "UMR is the unified model registry for your local AI apps. (v0.1.0)",
  );
  expect(stdoutRaw.join("")).not.toContain("Usage: umr [options] [command]");
  expect(stderrRaw.join("")).not.toContain("unknown command");
});

test("list prints a modern table with humanized sizes", async () => {
  const lines: string[] = [];
  const code = await runCli(["list"], {
    manager: createFakeManager() as never,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(`ERR:${line}`),
  });

  expect(code).toBe(0);
  expect(lines).toEqual([
    "NAME        SOURCE  FORMAT  SIZE   CLIENTS    STATUS",
    "tiny-model  local   gguf    123 B  LM Studio  ok",
    "",
    "Found 1 tracked model (total 123 B on disk)",
    "123 B saved with UMR",
  ]);
});

test("list omits the saved footer when no clients are linked", async () => {
  const lines: string[] = [];
  const code = await runCli(["list"], {
    manager: createFakeManager({
      listRows: [
        {
          name: "tiny-model",
          sourceKind: "local",
          format: "gguf",
          totalSizeBytes: 123,
          registrations: [],
          health: "ok",
        },
      ],
    }) as never,
    stdout: (line) => lines.push(line),
    stderr: () => {},
  });

  expect(code).toBe(0);
  expect(lines).toEqual([
    "NAME        SOURCE  FORMAT  SIZE   CLIENTS  STATUS",
    "tiny-model  local   gguf    123 B  -        ok",
    "",
    "Found 1 tracked model (total 123 B on disk)",
  ]);
});

test("show prints a compact detail block", async () => {
  const lines: string[] = [];
  const code = await runCli(["show", "tiny-model"], {
    manager: createFakeManager() as never,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(`ERR:${line}`),
  });

  expect(code).toBe(0);
  expect(lines).toEqual([
    "tiny-model",
    "  File      tiny.gguf",
    "  Size      123 B",
    "  Source    Local path",
    "  Clients   LM Studio",
    "  Path      /tmp/model-root/tiny.gguf",
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

test("show makes Hugging Face provenance explicit", async () => {
  const lines: string[] = [];
  const code = await runCli(["show", "tiny-model"], {
    manager: createFakeManager({
      model: createModel({
        sources: [
          {
            id: "1",
            modelId: "1",
            kind: "hf",
            payload: { repo: "ggml-org/gemma-4-E2B-it-GGUF" },
            createdAt: 0,
          },
        ],
        registrations: [],
      }),
    }) as never,
    stdout: (line) => lines.push(line),
    stderr: () => {},
  });

  expect(code).toBe(0);
  expect(lines).toEqual([
    "tiny-model",
    "  File      tiny.gguf",
    "  Size      123 B",
    "  Source    Hugging Face",
    "  Repo      ggml-org/gemma-4-E2B-it-GGUF",
    "  Clients   none",
    "  Path      /tmp/model-root/tiny.gguf",
  ]);
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
    "Added model tiny-model to UMR",
    "",
    "Path: /tmp/model-root/tiny.gguf",
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
  const stdoutLines: string[] = [];
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
      stdout: (line) => stdoutLines.push(line),
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
  expect(stdoutLines).toEqual([
    "Added model tiny-model to UMR",
    "",
    "Path: /tmp/model-root/tiny.gguf",
  ]);
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
  expect(
    stderrLines.at(-1),
  ).toBe(`error: Multiple GGUF files found in repo/name.
Use --file to choose one:
  tiny-q4.gguf  Download Required
  tiny-q8.gguf  Download Required`);
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
  expect(stderrLines.at(-1)).toContain(
    "error: Hugging Face downloads require confirmation",
  );
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
    "Model existing-model is already in UMR",
    "",
    "Path: /tmp/existing-model/tiny.gguf",
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
      hint: "Already Added to UMR",
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

test("link and unlink use clean client-facing wording", async () => {
  const stdoutLines: string[] = [];
  const code = await runCli(["link", "lmstudio", "tiny-model"], {
    manager: createFakeManager() as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stdoutLines).toEqual(["Linked model tiny-model to LM Studio"]);

  stdoutLines.length = 0;
  const unlinkCode = await runCli(["unlink", "lmstudio", "tiny-model"], {
    manager: createFakeManager() as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(unlinkCode).toBe(0);
  expect(stdoutLines).toEqual(["Unlinked model tiny-model from LM Studio"]);
});

test("remove uses clean success wording", async () => {
  const stdoutLines: string[] = [];
  const code = await runCli(["remove", "tiny-model"], {
    manager: createFakeManager() as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stdoutLines).toEqual(["Removed model tiny-model from UMR"]);
});

test("remove with existing links explains how to unlink first", async () => {
  const stderrLines: string[] = [];
  const code = await runCli(["remove", "tiny-model"], {
    manager: createFakeManager({
      model: createModel({
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
    }) as never,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(2);
  expect(stderrLines).toEqual([
    `Cannot remove model tiny-model while links exist.

Unlink it first:
  umr unlink lmstudio tiny-model`,
  ]);
});

test("remove with existing links highlights the model name in color mode", async () => {
  const stderrLines: string[] = [];
  const code = await runCli(["remove", "tiny-model"], {
    color: true,
    manager: createFakeManager({
      model: createModel({
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
    }) as never,
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(2);
  expect(stderrLines[0]).toContain("\u001b[");
  expect(stderrLines[0]).toContain("tiny-model");
});

test("check clean state prints a terse summary", async () => {
  const stdoutLines: string[] = [];
  const code = await runCli(["check"], {
    manager: createFakeManager({
      checkResult: {
        ok: true,
        fixed: false,
        checkedModels: 3,
        issues: [],
        repairs: [],
      },
    }) as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: () => {},
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(0);
  expect(stdoutLines).toEqual(["Checked 3 models. No issues found."]);
});

test("check groups issues and suggests safe repairs when available", async () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const code = await runCli(["check"], {
    manager: createFakeManager({
      checkResult: {
        ok: false,
        fixed: false,
        checkedModels: 3,
        issues: [
          {
            severity: "error",
            ref: "tiny-test-model",
            code: "missing-entry-path",
            fixable: false,
          },
          {
            severity: "warning",
            ref: "zephyr-smol-llama-100m-sft-full-q2-k",
            code: "lmstudio:missing-target-path",
            fixable: true,
          },
        ],
        repairs: [],
      },
    }) as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(3);
  expect(stdoutLines).toEqual([
    "Checked 3 models. Found 2 issues. 1 can be fixed automatically.",
    "",
    "tiny-test-model",
    "  Missing model file. Re-add the model or remove it from UMR.",
    "",
    "zephyr-smol-llama-100m-sft-full-q2-k (Fixable)",
    "  LM Studio link is stale.",
    "",
    "Run `umr check --fix` to apply safe repairs.",
  ]);
  expect(stderrLines).toEqual([]);
});

test("check --fix shows fixed repairs and remaining issues", async () => {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const code = await runCli(["check", "--fix"], {
    manager: createFakeManager({
      checkResult: {
        ok: false,
        fixed: true,
        checkedModels: 3,
        issues: [
          {
            severity: "error",
            ref: "tiny-test-model",
            code: "missing-entry-path",
            fixable: false,
          },
        ],
        repairs: [
          {
            ref: "zephyr-smol-llama-100m-sft-full-q2-k",
            message: "Removed stale LM Studio link.",
          },
        ],
      },
    }) as never,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    stdoutRaw: () => {},
    stderrRaw: () => {},
  });

  expect(code).toBe(3);
  expect(stdoutLines).toEqual([
    "Checked 3 models. Fixed 1 issue. 1 issue remains.",
    "",
    "Fixed",
    "  zephyr-smol-llama-100m-sft-full-q2-k",
    "    Removed stale LM Studio link.",
    "",
    "tiny-test-model",
    "  Missing model file. Re-add the model or remove it from UMR.",
  ]);
  expect(stderrLines).toEqual([]);
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

test("color output highlights key entities", async () => {
  const lines: string[] = [];
  const code = await runCli(["show", "tiny-model"], {
    color: true,
    manager: createFakeManager() as never,
    stdout: (line) => lines.push(line),
    stderr: () => {},
  });

  expect(code).toBe(0);
  expect(lines[0]).toContain("\u001b[");
  expect(lines[0]).toContain("tiny-model");
});
