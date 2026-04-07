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

function formatGGUFFiles(files: string[]): string {
  return files.map((file) => `  - ${file}`).join("\n");
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

  write(
    "NAME                             REF                SIZE      REGS          HEALTH",
  );
  for (const row of rows) {
    const registrations =
      row.registrations.length > 0 ? row.registrations.join(",") : "-";
    write(
      `${row.name.padEnd(32)} ${row.ref.padEnd(18)} ${String(row.totalSizeBytes).padEnd(9)} ${registrations.padEnd(13)} ${row.health}`,
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
  constructor(private readonly write: (line: string) => void) {}

  emit(event: ProgressEvent): void {
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

async function resolveHFFileSelection(
  manager: VirtualModelRegistry,
  repo: string,
  revision: string | undefined,
  requestedFile: string | undefined,
  interactive: boolean,
  prompts: PromptClient,
  reporter: CliProgressReporter,
): Promise<{ file: string; resolvedRevision: string }> {
  const inspection = await manager.inspectHFSource(
    { repo, revision },
    { reporter },
  );

  if (requestedFile) {
    if (!inspection.ggufFiles.includes(requestedFile)) {
      throw new ManagerError(
        `GGUF file not found in ${repo}: ${requestedFile}\nAvailable GGUF files:\n${formatGGUFFiles(inspection.ggufFiles)}`,
        {
          code: "hf-missing-file",
          exitCode: 2,
        },
      );
    }

    return {
      file: requestedFile,
      resolvedRevision: inspection.resolvedRevision,
    };
  }

  if (inspection.ggufFiles.length === 1) {
    return {
      file: inspection.ggufFiles[0],
      resolvedRevision: inspection.resolvedRevision,
    };
  }

  if (!interactive) {
    throw new ManagerError(
      `Multiple GGUF files found in ${repo}; rerun with --file explicitly:\n${formatGGUFFiles(inspection.ggufFiles)}`,
      {
        code: "hf-file-required",
        exitCode: 2,
      },
    );
  }

  const file = await prompts.select({
    message: "Choose a GGUF file to install",
    options: inspection.ggufFiles.map((candidate) => ({
      value: candidate,
      label: candidate,
    })),
  });

  return {
    file,
    resolvedRevision: inspection.resolvedRevision,
  };
}

async function confirmHFInstall(
  manager: VirtualModelRegistry,
  repo: string,
  resolvedRevision: string,
  file: string,
  yes: boolean,
  interactive: boolean,
  prompts: PromptClient,
): Promise<boolean> {
  const tracked = manager.findTrackedSource("hf", {
    repo,
    revision: resolvedRevision,
    file,
  });
  if (tracked) {
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
    message: `Install model?\nRepo: ${repo}\nFile: ${file}\nRevision: ${resolvedRevision}`,
  });
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
  const reporter = new CliProgressReporter(stderr);
  const streamSink = createStreamSink(stderrRaw, stdoutRaw);
  const interactive =
    options?.interactive ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompts = options?.prompts ?? createDefaultPromptClient();

  const program = new Command();
  program
    .name("vmr")
    .description("Virtual Model Registry")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (chunk) => stdoutRaw.write(chunk),
      writeErr: (chunk) => stderrRaw.write(chunk),
    })
    .exitOverride();

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

          const { file, resolvedRevision } = await resolveHFFileSelection(
            manager,
            repo,
            commandOptions.revision,
            commandOptions.file,
            interactive,
            prompts,
            reporter,
          );
          const shouldInstall = await confirmHFInstall(
            manager,
            repo,
            resolvedRevision,
            file,
            Boolean(commandOptions.yes),
            interactive,
            prompts,
          );

          if (!shouldInstall) {
            const tracked = manager.findTrackedSource("hf", {
              repo,
              revision: resolvedRevision,
              file,
            });
            if (tracked) {
              stdout(`existing: ${tracked.name} (${tracked.ref})`);
              stdout(tracked.entryPath);
              return;
            }
          }

          const result = await manager.addSource(
            "hf",
            { repo, file, revision: resolvedRevision },
            { reporter, streamSink },
          );
          stdout(
            `${result.status}: ${result.model.name} (${result.model.ref})`,
          );
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
        stdout(`${result.status}: ${result.model.name} (${result.model.ref})`);
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
      stdout(`ref: ${model.ref}`);
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
