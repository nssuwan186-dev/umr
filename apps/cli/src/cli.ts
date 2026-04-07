import {
  confirm as clackConfirm,
  select as clackSelect,
  isCancel,
} from "@clack/prompts";
import {
  type CheckResult,
  ManagerError,
  type ModelDetails,
  type ProgressEvent,
  type StreamSink,
  type VirtualModelRegistry,
  asManagerError,
  createDefaultVMR,
} from "@vmr/core";
import { Command, CommanderError } from "commander";

interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

type HFSelectionState =
  | "already-added-to-vmr"
  | "available-locally-in-hf"
  | "download-required";

interface HFSelectableFile {
  file: string;
  state: HFSelectionState;
  trackedModel?: ModelDetails;
}

interface PromptClient {
  confirm(input: { message: string }): Promise<boolean>;
  select(input: {
    message: string;
    options: PromptOption[];
  }): Promise<string>;
}

interface BufferedRawWriter {
  write(chunk: string): void;
  flush(): void;
}

function formatSources(model: ModelDetails): string {
  return model.sources
    .map(
      (source) =>
        `${source.kind}:${Object.entries(source.payload)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(",")}`,
    )
    .join("\n");
}

function formatRegistrations(model: ModelDetails): string {
  if (model.registrations.length === 0) {
    return "none";
  }

  return model.registrations
    .map(
      (registration) => `${registration.client} -> ${registration.clientRef}`,
    )
    .join("\n");
}

function formatGGUFFiles(files: HFSelectableFile[]): string {
  return files
    .map((file) => `  - ${file.file} (${formatHFSelectionState(file.state)})`)
    .join("\n");
}

function printCheck(result: CheckResult, write: (line: string) => void): void {
  if (result.issues.length === 0) {
    write(result.fixed ? "check: clean (repairs applied)" : "check: clean");
    return;
  }

  write(
    result.fixed
      ? "check: issues found (repairs applied where safe)"
      : "check: issues found",
  );
  for (const issue of result.issues) {
    write(`- [${issue.severity}] ${issue.ref ?? "global"} ${issue.message}`);
  }
}

function printList(
  rows: Awaited<ReturnType<VirtualModelRegistry["listModels"]>>,
  write: (line: string) => void,
): void {
  if (rows.length === 0) {
    write("No models tracked.");
    return;
  }

  write("NAME                             SIZE      REGS          HEALTH");
  for (const row of rows) {
    const registrations =
      row.registrations.length > 0 ? row.registrations.join(",") : "-";
    write(
      `${row.name.padEnd(32)} ${String(row.totalSizeBytes).padEnd(9)} ${registrations.padEnd(13)} ${row.health}`,
    );
  }
}

function createDefaultPromptClient(): PromptClient {
  return {
    async confirm(input) {
      const result = await clackConfirm({ message: input.message });
      if (isCancel(result)) {
        throw new ManagerError("Canceled", {
          code: "prompt-canceled",
          exitCode: 130,
        });
      }

      return result;
    },
    async select(input) {
      const result = await clackSelect({
        message: input.message,
        options: input.options,
      });
      if (isCancel(result)) {
        throw new ManagerError("Canceled", {
          code: "prompt-canceled",
          exitCode: 130,
        });
      }

      return result;
    },
  };
}

function createBufferedRawWriter(
  lineWriter: ((line: string) => void) | undefined,
  rawWriter: ((chunk: string) => void) | undefined,
): BufferedRawWriter {
  let buffer = "";

  return {
    write(chunk: string) {
      if (rawWriter) {
        rawWriter(chunk);
        return;
      }

      if (!lineWriter) {
        return;
      }

      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        lineWriter(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (!rawWriter && lineWriter && buffer.length > 0) {
        lineWriter(buffer);
      }
      buffer = "";
    },
  };
}

function createStreamSink(
  stderrRaw: BufferedRawWriter,
  stdoutRaw: BufferedRawWriter,
): StreamSink {
  return {
    stderr(chunk: string) {
      stderrRaw.write(chunk);
    },
    stdout(chunk: string) {
      stdoutRaw.write(chunk);
    },
  };
}

class CliProgressReporter {
  constructor(
    private readonly write: (line: string) => void,
    private enabled = false,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  emit(event: ProgressEvent): void {
    if (!this.enabled) {
      return;
    }

    if (event.level === "warning") {
      this.write(`warn: ${event.message}`);
      return;
    }

    if (event.level === "success") {
      this.write(`ok: ${event.message}`);
      return;
    }

    this.write(`-> ${event.message}`);
  }
}

function formatHFSelectionState(state: HFSelectionState): string {
  switch (state) {
    case "already-added-to-vmr":
      return "Already Added to VMR";
    case "available-locally-in-hf":
      return "Available Locally in HF";
    case "download-required":
      return "Download Required";
  }
}

function getHFSelectableFiles(
  manager: VirtualModelRegistry,
  repo: string,
  inspection: Awaited<ReturnType<VirtualModelRegistry["inspectHFSource"]>>,
): HFSelectableFile[] {
  return inspection.ggufFiles.map((file) => {
    const trackedModel = manager.findTrackedSource("hf", {
      repo,
      revision: inspection.resolvedRevision,
      file,
    });
    if (trackedModel) {
      return {
        file,
        state: "already-added-to-vmr",
        trackedModel,
      };
    }

    if (inspection.cachedFiles.includes(file)) {
      return {
        file,
        state: "available-locally-in-hf",
      };
    }

    return {
      file,
      state: "download-required",
    };
  });
}

async function resolveHFFileSelection(
  manager: VirtualModelRegistry,
  repo: string,
  revision: string | undefined,
  requestedFile: string | undefined,
  interactive: boolean,
  prompts: PromptClient,
  reporter: CliProgressReporter,
): Promise<{
  file: string;
  resolvedRevision: string;
  selected: HFSelectableFile;
}> {
  const inspection = await manager.inspectHFSource(
    { repo, revision },
    { reporter },
  );
  const selectableFiles = getHFSelectableFiles(manager, repo, inspection);

  if (requestedFile) {
    const selected = selectableFiles.find(
      (file) => file.file === requestedFile,
    );
    if (!selected) {
      throw new ManagerError(
        `GGUF file not found in ${repo}: ${requestedFile}\nAvailable GGUF files:\n${formatGGUFFiles(selectableFiles)}`,
        {
          code: "hf-missing-file",
          exitCode: 2,
        },
      );
    }

    return {
      file: requestedFile,
      resolvedRevision: inspection.resolvedRevision,
      selected,
    };
  }

  if (selectableFiles.length === 1) {
    return {
      file: selectableFiles[0].file,
      resolvedRevision: inspection.resolvedRevision,
      selected: selectableFiles[0],
    };
  }

  if (!interactive) {
    throw new ManagerError(
      `Multiple GGUF files found in ${repo}; rerun with --file explicitly:\n${formatGGUFFiles(selectableFiles)}`,
      {
        code: "hf-file-required",
        exitCode: 2,
      },
    );
  }

  const file = await prompts.select({
    message: "Choose a GGUF file",
    options: selectableFiles.map((candidate) => ({
      value: candidate.file,
      label: candidate.file,
      hint: formatHFSelectionState(candidate.state),
    })),
  });
  const selected = selectableFiles.find((candidate) => candidate.file === file);
  if (!selected) {
    throw new ManagerError(`Failed to resolve selected GGUF file: ${file}`, {
      code: "hf-file-selection",
      exitCode: 1,
    });
  }

  return {
    file,
    resolvedRevision: inspection.resolvedRevision,
    selected,
  };
}

async function confirmHFInstall(
  repo: string,
  resolvedRevision: string,
  selected: HFSelectableFile,
  yes: boolean,
  interactive: boolean,
  prompts: PromptClient,
): Promise<boolean> {
  if (selected.state !== "download-required") {
    return false;
  }

  if (yes) {
    return true;
  }

  if (!interactive) {
    throw new ManagerError(
      "Hugging Face downloads require confirmation in non-interactive mode; rerun with --yes",
      {
        code: "hf-confirm-required",
        exitCode: 2,
      },
    );
  }

  return prompts.confirm({
    message: `Download and add to VMR?\nRepo: ${repo}\nFile: ${selected.file}\nRevision: ${resolvedRevision}`,
  });
}

function hasVerboseFlag(argv: string[]): boolean {
  return argv.includes("--verbose") || argv.includes("-v");
}

export async function runCli(
  argv: string[],
  options?: {
    manager?: VirtualModelRegistry;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    stdoutRaw?: (chunk: string) => void;
    stderrRaw?: (chunk: string) => void;
    interactive?: boolean;
    prompts?: PromptClient;
    verbose?: boolean;
  },
): Promise<number> {
  const manager = options?.manager ?? createDefaultVMR();
  const stdout = options?.stdout ?? ((line: string) => console.log(line));
  const stderr = options?.stderr ?? ((line: string) => console.error(line));
  const stdoutRaw = createBufferedRawWriter(
    options?.stdout ? stdout : undefined,
    options?.stdoutRaw ?? ((chunk: string) => process.stdout.write(chunk)),
  );
  const stderrRaw = createBufferedRawWriter(
    options?.stderr ? stderr : undefined,
    options?.stderrRaw ?? ((chunk: string) => process.stderr.write(chunk)),
  );
  const reporter = new CliProgressReporter(
    stderr,
    options?.verbose ?? hasVerboseFlag(argv),
  );
  const streamSink = createStreamSink(stderrRaw, stdoutRaw);
  const interactive =
    options?.interactive ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompts = options?.prompts ?? createDefaultPromptClient();

  const program = new Command();
  program
    .name("vmr")
    .description("Virtual Model Registry")
    .option("-v, --verbose", "Show internal progress steps")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (chunk) => stdoutRaw.write(chunk),
      writeErr: (chunk) => stderrRaw.write(chunk),
    })
    .exitOverride();

  program.hook("preAction", (command) => {
    const verbose =
      command.optsWithGlobals<{ verbose?: boolean }>().verbose ??
      options?.verbose ??
      false;
    reporter.setEnabled(verbose);
  });

  program
    .command("add")
    .description("Add a local path or an explicit source")
    .usage(
      "hf <repo> [--file <filename>] [--revision <rev>] [--yes]\n  vmr add <path>",
    )
    .argument("<sourceOrPath>", "Source keyword or local path")
    .argument("[value]", "Source-specific value")
    .option(
      "--file <filename>",
      "Explicit GGUF filename for Hugging Face repos",
    )
    .option("--revision <revision>", "Revision, branch, or commit to resolve")
    .option("-y, --yes", "Skip interactive confirmation prompts")
    .action(
      async (
        sourceOrPath: string,
        value: string | undefined,
        commandOptions: {
          file?: string;
          revision?: string;
          yes?: boolean;
        },
      ) => {
        if (sourceOrPath === "hf") {
          const repo = value;
          if (!repo) {
            throw new ManagerError("Missing Hugging Face repo", {
              code: "missing-hf-repo",
              exitCode: 2,
            });
          }

          const { file, resolvedRevision, selected } =
            await resolveHFFileSelection(
              manager,
              repo,
              commandOptions.revision,
              commandOptions.file,
              interactive,
              prompts,
              reporter,
            );
          const shouldInstall = await confirmHFInstall(
            repo,
            resolvedRevision,
            selected,
            Boolean(commandOptions.yes),
            interactive,
            prompts,
          );

          if (!shouldInstall) {
            if (selected.trackedModel) {
              stdout(`existing: ${selected.trackedModel.name}`);
              stdout(selected.trackedModel.entryPath);
              return;
            }
          }

          const result = await manager.addSource(
            "hf",
            { repo, file, revision: resolvedRevision },
            { reporter, streamSink },
          );
          stdout(`${result.status}: ${result.model.name}`);
          stdout(result.model.entryPath);
          return;
        }

        if (value !== undefined) {
          throw new ManagerError("Usage: vmr add <path>", {
            code: "unexpected-add-argument",
            exitCode: 2,
          });
        }

        const result = await manager.addSource(
          "path",
          { path: sourceOrPath },
          { reporter, streamSink },
        );
        stdout(`${result.status}: ${result.model.name}`);
        stdout(result.model.entryPath);
      },
    );

  program
    .command("list")
    .description("List tracked models")
    .action(async () => {
      printList(await manager.listModels(), stdout);
    });

  program
    .command("show")
    .description("Show a tracked model")
    .argument("<model>", "Model selector")
    .option("--path", "Print only the model entry path")
    .action((selector: string, commandOptions: { path?: boolean }) => {
      const model = manager.getModel(selector);
      if (commandOptions.path) {
        stdout(model.entryPath);
        return;
      }

      stdout(`name: ${model.name}`);
      stdout(`filename: ${model.entryFilename}`);
      stdout(`path: ${model.entryPath}`);
      stdout(`content-digest: ${model.contentDigest}`);
      stdout(`size: ${model.totalSizeBytes}`);
      stdout(`sources:\n${formatSources(model)}`);
      stdout(`registrations:\n${formatRegistrations(model)}`);
    });

  program
    .command("register")
    .description("Register a model with a client")
    .argument("<client>", "Client name")
    .argument("<model>", "Model selector")
    .action(async (client: string, selector: string) => {
      const registration = await manager.register(client, selector, {
        reporter,
        streamSink,
      });
      stdout(
        `registered ${selector} with ${client}: ${registration.clientRef}`,
      );
    });

  program
    .command("unregister")
    .description("Remove a client registration")
    .argument("<client>", "Client name")
    .argument("<model>", "Model selector")
    .action(async (client: string, selector: string) => {
      await manager.unregister(client, selector, { reporter, streamSink });
      stdout(`unregistered ${selector} from ${client}`);
    });

  program
    .command("remove")
    .description("Remove a model from managed storage")
    .argument("<model>", "Model selector")
    .action(async (selector: string) => {
      await manager.remove(selector, { reporter, streamSink });
      stdout(`removed ${selector}`);
    });

  program
    .command("check")
    .description("Check managed state and optionally repair stale records")
    .option("--fix", "Apply safe repairs")
    .action(async (commandOptions: { fix?: boolean }) => {
      const result = await manager.check({ fix: commandOptions.fix, reporter });
      printCheck(result, stdout);
      if (result.issues.length > 0) {
        throw new ManagerError("check completed with issues", {
          code: "check-issues",
          exitCode: 3,
        });
      }
    });

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }

    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    stdoutRaw.flush();
    stderrRaw.flush();

    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const managerError = asManagerError(error);
    stderr(managerError.message);
    return managerError.exitCode;
  } finally {
    stdoutRaw.flush();
    stderrRaw.flush();
  }
}
