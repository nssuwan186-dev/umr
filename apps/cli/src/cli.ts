import {
  confirm as clackConfirm,
  select as clackSelect,
  isCancel,
} from "@clack/prompts";
import {
  type CheckIssue,
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

const ROOT_HELP = `Virtual Model Registry

Usage:
  vmr <command> [...flags]

Commands:
  add <path>                  Add a local model
  add hf <repo>               Add a model from Hugging Face
  list                        List tracked models
  show <model>                Show model details
  register <client> <model>   Register a model with a client
  unregister <client> <model> Remove a client registration
  remove <model>              Remove a model from VMR
  check                       Check VMR state and registrations

Flags:
  -v, --verbose               Show detailed progress
  -h, --help                  Print help

Use \`vmr <command> --help\` for more information about a command.
`;

const ADD_HELP = `Usage:
  vmr add <path>
  vmr add hf <repo> [--file <name>] [--revision <rev>] [--yes]

Add a model from a local path or Hugging Face.

Options:
  --file <name>               Choose a GGUF file from the repo
  --revision <rev>            Resolve a specific branch, tag, or commit
  -y, --yes                   Skip download confirmation
  -h, --help                  Print help
`;

function humanizeBytes(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${value} ${units[unitIndex]}`;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const formatted = value.toFixed(precision);
  return `${formatted.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")} ${units[unitIndex]}`;
}

function formatSource(model: ModelDetails): string {
  const hfSource = model.sources.find((source) => {
    const repo = source.payload.repo;
    return source.kind === "hf" && typeof repo === "string" && repo.trim();
  });
  if (hfSource) {
    return String(hfSource.payload.repo);
  }

  if (model.sources.some((source) => source.kind === "path")) {
    return "local path";
  }

  return model.sources[0]?.kind ?? "unknown";
}

function formatClients(model: ModelDetails): string {
  if (model.registrations.length === 0) {
    return "none";
  }

  return model.registrations
    .map((registration) => registration.client)
    .join(",");
}

function formatClientName(client: string): string {
  switch (client) {
    case "lmstudio":
      return "LM Studio";
    case "ollama":
      return "Ollama";
    case "jan":
      return "Jan";
    default:
      return client;
  }
}

function formatGGUFFiles(files: HFSelectableFile[]): string {
  return files
    .map(
      (file) =>
        `  ${file.file.padEnd(42)} ${formatHFSelectionState(file.state)}`,
    )
    .join("\n");
}

function formatCheckIssue(issue: CheckIssue): string {
  switch (issue.code) {
    case "missing-model-root":
    case "missing-entry-path":
      return "Missing model file. Re-add the model or remove it from VMR.";
  }

  if (issue.code.startsWith("missing-member:")) {
    return "Missing model file. Re-add the model or remove it from VMR.";
  }

  if (issue.code.startsWith("member-size-mismatch:")) {
    return "Model files no longer match VMR metadata. Re-add the model.";
  }

  if (issue.code.startsWith("invalid-gguf:")) {
    return "Model file is not a valid GGUF. Re-add the model.";
  }

  if (issue.code === "lmstudio:missing-target-path") {
    return "LM Studio registration is stale.";
  }

  if (issue.code.startsWith("lmstudio:")) {
    return "LM Studio registration needs attention.";
  }

  if (issue.code.startsWith("ollama:")) {
    return "Ollama registration needs attention.";
  }

  if (issue.code.startsWith("jan:")) {
    return "Jan registration needs attention.";
  }

  return "VMR detected an issue that requires attention.";
}

function printCheck(result: CheckResult, write: (line: string) => void): void {
  if (result.issues.length === 0) {
    if (result.repairs.length > 0) {
      write(
        `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. Fixed ${result.repairs.length} ${result.repairs.length === 1 ? "issue" : "issues"}.`,
      );
      write("");
      write("Fixed");
      for (const repair of result.repairs) {
        if (repair.ref) {
          write(`  ${repair.ref}`);
          write(`    ${repair.message}`);
        } else {
          write(`  ${repair.message}`);
        }
      }
      return;
    }

    write(
      `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. No issues found.`,
    );
    return;
  }

  const fixableCount = result.issues.filter((issue) => issue.fixable).length;
  if (result.repairs.length > 0) {
    write(
      `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. Fixed ${result.repairs.length} ${result.repairs.length === 1 ? "issue" : "issues"}. ${result.issues.length} ${result.issues.length === 1 ? "issue remains" : "issues remain"}.`,
    );
    write("");
    write("Fixed");
    for (const repair of result.repairs) {
      if (repair.ref) {
        write(`  ${repair.ref}`);
        write(`    ${repair.message}`);
      } else {
        write(`  ${repair.message}`);
      }
    }
    write("");
  } else {
    let summary = `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. Found ${result.issues.length} ${result.issues.length === 1 ? "issue" : "issues"}.`;
    if (fixableCount > 0) {
      summary += ` ${fixableCount} can be fixed automatically.`;
    }
    write(summary);
    write("");
  }

  const groupedIssues = new Map<
    string,
    { fixable: boolean; messages: string[] }
  >();
  for (const issue of result.issues) {
    const ref = issue.ref ?? "VMR";
    const existing = groupedIssues.get(ref);
    if (existing) {
      existing.fixable ||= issue.fixable;
      existing.messages.push(formatCheckIssue(issue));
      continue;
    }

    groupedIssues.set(ref, {
      fixable: issue.fixable,
      messages: [formatCheckIssue(issue)],
    });
  }

  let firstGroup = true;
  for (const [ref, group] of groupedIssues) {
    if (!firstGroup) {
      write("");
    }
    write(`${ref}${group.fixable ? " (Fixable)" : ""}`);
    for (const message of group.messages) {
      write(`  ${message}`);
    }
    firstGroup = false;
  }

  if (fixableCount > 0 && result.repairs.length === 0) {
    write("");
    write("Run `vmr check --fix` to apply safe repairs.");
  }
}

function printList(
  rows: Awaited<ReturnType<VirtualModelRegistry["listModels"]>>,
  write: (line: string) => void,
): void {
  if (rows.length === 0) {
    write("No models found.");
    return;
  }

  const nameWidth = Math.max(
    "NAME".length,
    ...rows.map((row) => row.name.length),
  );
  const clientWidth = Math.max(
    "CLIENTS".length,
    ...rows.map((row) =>
      row.registrations.length > 0 ? row.registrations.join(",").length : 1,
    ),
  );
  write(
    `${"NAME".padEnd(nameWidth)}  ${"SIZE".padEnd(8)}  ${"CLIENTS".padEnd(clientWidth)}  STATUS`,
  );
  for (const row of rows) {
    const registrations =
      row.registrations.length > 0 ? row.registrations.join(",") : "-";
    write(
      `${row.name.padEnd(nameWidth)}  ${humanizeBytes(row.totalSizeBytes).padEnd(8)}  ${registrations.padEnd(clientWidth)}  ${row.health}`,
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

function shouldPrintRootHelp(argv: string[]): boolean {
  return (
    argv.length === 0 ||
    (argv.length === 1 &&
      (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help"))
  );
}

function shouldPrintAddHelp(argv: string[]): boolean {
  return (
    (argv[0] === "add" &&
      argv.some((arg) => arg === "--help" || arg === "-h")) ||
    (argv[0] === "help" && argv[1] === "add")
  );
}

export async function runCli(
  argv: string[],
  options?: {
    manager?: VirtualModelRegistry;
    createManager?: () => VirtualModelRegistry;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    stdoutRaw?: (chunk: string) => void;
    stderrRaw?: (chunk: string) => void;
    interactive?: boolean;
    prompts?: PromptClient;
    verbose?: boolean;
  },
): Promise<number> {
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
  let manager = options?.manager;
  const getManager = (): VirtualModelRegistry => {
    manager ??= options?.createManager?.() ?? createDefaultVMR();
    return manager;
  };

  if (shouldPrintRootHelp(argv)) {
    stdoutRaw.write(ROOT_HELP);
    stdoutRaw.flush();
    return 0;
  }

  if (shouldPrintAddHelp(argv)) {
    stdoutRaw.write(ADD_HELP);
    stdoutRaw.flush();
    return 0;
  }

  const program = new Command();
  program
    .name("vmr")
    .description("Virtual Model Registry")
    .option("-v, --verbose", "Show detailed progress")
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
          const manager = getManager();
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
              stdout(`Already added ${selected.trackedModel.name}`);
              stdout("");
              stdout(`Path: ${selected.trackedModel.entryPath}`);
              return;
            }
          }

          const result = await manager.addSource(
            "hf",
            { repo, file, revision: resolvedRevision },
            { reporter, streamSink },
          );
          stdout(
            `${result.status === "existing" ? "Already added" : "Added"} ${result.model.name}`,
          );
          stdout("");
          stdout(`Path: ${result.model.entryPath}`);
          return;
        }

        if (value !== undefined) {
          throw new ManagerError("Usage: vmr add <path>", {
            code: "unexpected-add-argument",
            exitCode: 2,
          });
        }

        const result = await getManager().addSource(
          "path",
          { path: sourceOrPath },
          { reporter, streamSink },
        );
        stdout(
          `${result.status === "existing" ? "Already added" : "Added"} ${result.model.name}`,
        );
        stdout("");
        stdout(`Path: ${result.model.entryPath}`);
      },
    );

  program
    .command("list")
    .description("List tracked models")
    .action(async () => {
      printList(await getManager().listModels(), stdout);
    });

  program
    .command("show")
    .description("Show a tracked model")
    .argument("<model>", "Model selector")
    .option("--path", "Print only the model entry path")
    .action((selector: string, commandOptions: { path?: boolean }) => {
      const model = getManager().getModel(selector);
      if (commandOptions.path) {
        stdout(model.entryPath);
        return;
      }

      stdout(model.name);
      stdout(`  File      ${model.entryFilename}`);
      stdout(`  Path      ${model.entryPath}`);
      stdout(`  Size      ${humanizeBytes(model.totalSizeBytes)}`);
      stdout(`  Source    ${formatSource(model)}`);
      stdout(`  Clients   ${formatClients(model)}`);
    });

  program
    .command("register")
    .description("Register a model with a client")
    .argument("<client>", "Client name")
    .argument("<model>", "Model selector")
    .action(async (client: string, selector: string) => {
      const registry = getManager();
      const model = registry.getModel(selector);
      await registry.register(client, selector, {
        reporter,
        streamSink,
      });
      stdout(`Registered ${model.name} with ${formatClientName(client)}`);
    });

  program
    .command("unregister")
    .description("Remove a client registration")
    .argument("<client>", "Client name")
    .argument("<model>", "Model selector")
    .action(async (client: string, selector: string) => {
      const registry = getManager();
      const model = registry.getModel(selector);
      await registry.unregister(client, selector, { reporter, streamSink });
      stdout(
        `Removed ${formatClientName(client)} registration for ${model.name}`,
      );
    });

  program
    .command("remove")
    .description("Remove a model from managed storage")
    .argument("<model>", "Model selector")
    .action(async (selector: string) => {
      const registry = getManager();
      const model = registry.getModel(selector);
      await registry.remove(selector, { reporter, streamSink });
      stdout(`Removed ${model.name}`);
    });

  program
    .command("check")
    .description("Check managed state and optionally repair stale records")
    .option("--fix", "Apply safe repairs")
    .action(async (commandOptions: { fix?: boolean }) => {
      const result = await getManager().check({
        fix: commandOptions.fix,
        reporter,
      });
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
