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
  type UnifiedModelRegistry,
  asManagerError,
  createDefaultUMR,
} from "@umr/core";
import { Command, CommanderError } from "commander";
import { type CliTheme, createTheme } from "./theme";

interface PromptOption {
  value: string;
  label: string;
  hint?: string;
}

type HFSelectionState =
  | "already-added-to-umr"
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

const UMR_VERSION = "0.1.0";

interface HelpRow {
  command: string;
  usage: string;
  description: string;
}

const SOURCE_ROWS: HelpRow[] = [
  {
    command: "<path>",
    usage: "",
    description: "Local file or directory",
  },
  {
    command: "hf",
    usage: "",
    description: "Hugging Face repo",
  },
];

const TARGET_ROWS: HelpRow[] = [
  {
    command: "lmstudio",
    usage: "",
    description: "LM Studio",
  },
  {
    command: "ollama",
    usage: "",
    description: "Ollama",
  },
  {
    command: "jan",
    usage: "",
    description: "Jan",
  },
];

function formatHelpRows(
  rows: HelpRow[],
  theme: CliTheme,
  options?: {
    commandStyle?: "command" | "flag" | "plain";
    usageStyle?: "accent" | "command" | "dim" | "flag" | "plain";
  },
): string[] {
  const commandWidth = Math.max(...rows.map((row) => row.command.length), 0);
  const usageWidth = Math.max(...rows.map((row) => row.usage.length), 0);
  const commandStyle = options?.commandStyle ?? "command";
  const usageStyle = options?.usageStyle ?? "accent";

  return rows.map((row) => {
    const commandColumn = row.command
      ? commandStyle === "flag"
        ? theme.flag(row.command.padEnd(commandWidth))
        : commandStyle === "plain"
          ? row.command.padEnd(commandWidth)
          : theme.command(row.command.padEnd(commandWidth))
      : "".padEnd(commandWidth);
    const usageText = row.usage.padEnd(usageWidth);
    const usageColumn =
      usageStyle === "command"
        ? theme.command(usageText)
        : usageStyle === "flag"
          ? theme.flag(usageText)
          : usageStyle === "dim"
            ? theme.dim(usageText)
            : usageStyle === "plain"
              ? usageText
              : theme.accent(usageText);

    if (usageWidth > 0) {
      return `  ${commandColumn}  ${usageColumn}  ${theme.description(row.description)}`;
    }

    return `  ${commandColumn}  ${theme.description(row.description)}`;
  });
}

function renderRootHelp(theme: CliTheme): string {
  const flagRows = [
    {
      command: "--verbose",
      usage: "",
      description: "Show detailed progress",
    },
    {
      command: "--version",
      usage: "",
      description: "Print version",
    },
    {
      command: "--help",
      usage: "",
      description: "Print help",
    },
  ];
  const commandWidth = "<command>".length;
  const usageWidth = "<target> <model>".length;
  const renderRow = (input: {
    command?: string;
    commandColor?: "add" | "blue" | "orange" | "plain";
    description: string;
    usage?: string;
    usageColor?: "dim" | "flag" | "plain";
  }) => {
    const command = input.command ?? "";
    const usage = input.usage ?? "";
    const coloredCommand =
      input.commandColor === "add"
        ? theme.addCommand(command.padEnd(commandWidth))
        : input.commandColor === "blue"
          ? theme.blueCommand(command.padEnd(commandWidth))
          : input.commandColor === "orange"
            ? theme.orangeCommand(command.padEnd(commandWidth))
            : input.commandColor === "plain"
              ? theme.dim(command.padEnd(commandWidth))
              : "".padEnd(commandWidth);
    const coloredUsage =
      input.usageColor === "flag"
        ? theme.flag(usage.padEnd(usageWidth))
        : input.usageColor === "plain"
          ? usage.padEnd(usageWidth)
          : theme.dim(usage.padEnd(usageWidth));

    return `  ${coloredCommand}  ${coloredUsage}  ${theme.description(input.description)}`;
  };

  return [
    `${theme.product("UMR")} is the unified model registry for your local AI apps. ${theme.muted(`(v${UMR_VERSION})`)}`,
    "",
    `${theme.heading("Usage:")} umr <command> [...flags] [...args]`,
    "",
    theme.heading("Commands:"),
    renderRow({
      command: "add",
      commandColor: "add",
      usage: "<source>",
      usageColor: "plain",
      description: "Add a model to UMR",
    }),
    renderRow({
      usage: "hf <repo>",
      description: "Add a model from Hugging Face",
    }),
    renderRow({
      usage: "<path>",
      description: "Add a local model",
    }),
    "",
    renderRow({
      command: "link",
      commandColor: "blue",
      usage: "<target> <model>",
      usageColor: "plain",
      description: "Link a model to a target app",
    }),
    renderRow({
      usage: "lmstudio <model>",
      description: "Link model to LM Studio",
    }),
    renderRow({
      usage: "ollama <model>",
      description: "Link model to Ollama",
    }),
    renderRow({
      usage: "jan <model>",
      description: "Link model to Jan",
    }),
    `  ${"".padEnd(commandWidth)}  ${theme.flag("--help".padEnd(usageWidth))}  ${theme.description("See full list")}`,
    renderRow({
      command: "unlink",
      commandColor: "blue",
      usage: "<target> <model>",
      usageColor: "plain",
      description: "Remove a model link from a target app",
    }),
    "",
    renderRow({
      command: "list",
      commandColor: "orange",
      description: "List tracked models",
    }),
    renderRow({
      command: "show",
      commandColor: "orange",
      usage: "<model>",
      usageColor: "plain",
      description: "Show model details",
    }),
    renderRow({
      command: "remove",
      commandColor: "orange",
      usage: "<model>",
      usageColor: "plain",
      description: "Remove a model from UMR",
    }),
    renderRow({
      command: "check",
      commandColor: "orange",
      description: "Check UMR state and target links",
    }),
    "",
    renderRow({
      command: "<command>",
      commandColor: "plain",
      usage: "--help",
      usageColor: "flag",
      description: "Print help text for command",
    }),
    "",
    theme.heading("Flags:"),
    ...formatHelpRows(flagRows, theme, {
      commandStyle: "flag",
      usageStyle: "plain",
    }),
    "",
  ].join("\n");
}

function renderSimpleHelp(options: {
  theme: CliTheme;
  usage: string[];
  description: string;
  options?: HelpRow[];
}): string {
  const { theme } = options;
  const lines = options.usage.map((line, index) =>
    index === 0 ? `${theme.heading("Usage:")} ${line}` : `       ${line}`,
  );
  lines.push("", options.description);

  if (options.options && options.options.length > 0) {
    lines.push("", theme.heading("Flags:"));
    lines.push(
      ...formatHelpRows(options.options, theme, {
        commandStyle: "flag",
        usageStyle: "plain",
      }),
    );
  }

  lines.push("");
  return lines.join("\n");
}

function renderAddHelp(theme: CliTheme): string {
  const optionRows = [
    {
      command: "--file <name>",
      usage: "",
      description: "Choose a GGUF file from the repo",
    },
    {
      command: "--revision <rev>",
      usage: "",
      description: "Resolve a branch, tag, or commit",
    },
    {
      command: "-y, --yes",
      usage: "",
      description: "Skip download confirmation",
    },
    {
      command: "-h, --help",
      usage: "",
      description: "Print help",
    },
  ];

  return [
    renderSimpleHelp({
      theme,
      usage: [
        "umr add <path>",
        "umr add hf <repo> [--file <name>] [--revision <rev>] [--yes]",
      ],
      description: "Add a model from a local path or Hugging Face.",
      options: optionRows,
    }),
    theme.heading("Sources:"),
    ...formatHelpRows(SOURCE_ROWS, theme, {
      commandStyle: "plain",
      usageStyle: "plain",
    }),
    "",
  ].join("\n");
}

function renderLinkHelp(theme: CliTheme, verb: "link" | "unlink"): string {
  const optionRows = [
    {
      command: "-h, --help",
      usage: "",
      description: "Print help",
    },
  ];

  return [
    renderSimpleHelp({
      theme,
      usage: [`umr ${verb} <target> <model>`],
      description:
        verb === "link"
          ? "Link a model to a target app."
          : "Remove a model link from a target app.",
      options: optionRows,
    }),
    theme.heading("Targets:"),
    ...formatHelpRows(TARGET_ROWS, theme, {
      commandStyle: "plain",
      usageStyle: "plain",
    }),
    "",
  ].join("\n");
}

function renderListHelp(theme: CliTheme): string {
  return renderSimpleHelp({
    theme,
    usage: ["umr list"],
    description: "List tracked models.",
    options: [
      {
        command: "--help",
        usage: "",
        description: "Print help",
      },
    ],
  });
}

function renderShowHelp(theme: CliTheme): string {
  return renderSimpleHelp({
    theme,
    usage: ["umr show <model> [--path]"],
    description: "Show details for a tracked model.",
    options: [
      {
        command: "--path",
        usage: "",
        description: "Print only the model entry path",
      },
      {
        command: "--help",
        usage: "",
        description: "Print help",
      },
    ],
  });
}

function renderRemoveHelp(theme: CliTheme): string {
  return renderSimpleHelp({
    theme,
    usage: ["umr remove <model>"],
    description: "Remove a model from UMR.",
    options: [
      {
        command: "--help",
        usage: "",
        description: "Print help",
      },
    ],
  });
}

function renderCheckHelp(theme: CliTheme): string {
  return renderSimpleHelp({
    theme,
    usage: ["umr check [--fix]"],
    description: "Check UMR state and target links.",
    options: [
      {
        command: "--fix",
        usage: "",
        description: "Apply safe repairs",
      },
      {
        command: "--help",
        usage: "",
        description: "Print help",
      },
    ],
  });
}

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

function describeSource(model: ModelDetails): {
  label: string;
  repo?: string;
} {
  const hfSource = model.sources.find((source) => {
    const repo = source.payload.repo;
    return source.kind === "hf" && typeof repo === "string" && repo.trim();
  });
  if (hfSource) {
    return {
      label: "Hugging Face",
      repo: String(hfSource.payload.repo),
    };
  }

  if (model.sources.some((source) => source.kind === "path")) {
    return { label: "Local path" };
  }

  return {
    label: model.sources[0]?.kind ?? "Unknown",
  };
}

function formatTargetNames(targets: string[]): string {
  if (targets.length === 0) {
    return "none";
  }

  return targets.map((target) => formatClientName(target)).join(", ");
}

function formatTargets(model: ModelDetails): string {
  return formatTargetNames(
    model.registrations.map((registration) => registration.client),
  );
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

function formatAddedModelMessage(
  theme: CliTheme,
  options: { name: string; alreadyInUMR?: boolean },
): string {
  if (options.alreadyInUMR) {
    return `${theme.accent("Model")} ${theme.model(options.name)} ${theme.accent("is already in UMR")}`;
  }

  return `${theme.success("Added model")} ${theme.model(options.name)} ${theme.success("to UMR")}`;
}

function formatGGUFFiles(files: HFSelectableFile[], theme: CliTheme): string {
  const width = Math.max(...files.map((file) => file.file.length), 0);
  return files
    .map(
      (file) =>
        `  ${file.file.padEnd(width)}  ${formatHFSelectionState(file.state, theme)}`,
    )
    .join("\n");
}

function formatCheckIssue(issue: CheckIssue): string {
  switch (issue.code) {
    case "missing-model-root":
    case "missing-entry-path":
      return "Missing model file. Re-add the model or remove it from UMR.";
  }

  if (issue.code.startsWith("missing-member:")) {
    return "Missing model file. Re-add the model or remove it from UMR.";
  }

  if (issue.code.startsWith("member-size-mismatch:")) {
    return "Model files no longer match UMR metadata. Re-add the model.";
  }

  if (issue.code.startsWith("invalid-gguf:")) {
    return "Model file is not a valid GGUF. Re-add the model.";
  }

  if (issue.code === "lmstudio:missing-target-path") {
    return "LM Studio link is stale.";
  }

  if (issue.code.startsWith("lmstudio:")) {
    return "LM Studio link needs attention.";
  }

  if (issue.code.startsWith("ollama:")) {
    return "Ollama link needs attention.";
  }

  if (issue.code.startsWith("jan:")) {
    return "Jan link needs attention.";
  }

  return "UMR detected an issue that requires attention.";
}

function formatDetailLine(
  theme: CliTheme,
  label: string,
  value: string,
  options?: { valueColor?: "accent" | "dim" | "model" | "plain" },
): string {
  const labelColumn = theme.label(label.padEnd(8));
  let renderedValue = value;
  switch (options?.valueColor) {
    case "accent":
      renderedValue = theme.accent(value);
      break;
    case "dim":
      renderedValue = theme.dim(value);
      break;
    case "model":
      renderedValue = theme.model(value);
      break;
    default:
      break;
  }

  return `  ${labelColumn}  ${renderedValue}`;
}

function printCheck(
  result: CheckResult,
  write: (line: string) => void,
  theme: CliTheme,
): void {
  if (result.issues.length === 0) {
    if (result.repairs.length > 0) {
      write(
        `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. Fixed ${result.repairs.length} ${result.repairs.length === 1 ? "issue" : "issues"}.`,
      );
      write("");
      write(theme.success(theme.heading("Fixed")));
      for (const repair of result.repairs) {
        if (repair.ref) {
          write(`  ${theme.model(repair.ref)}`);
          write(`    ${repair.message}`);
        } else {
          write(`  ${repair.message}`);
        }
      }
      return;
    }

    write(
      `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. ${theme.success("No issues found.")}`,
    );
    return;
  }

  const fixableCount = result.issues.filter((issue) => issue.fixable).length;
  if (result.repairs.length > 0) {
    write(
      `Checked ${result.checkedModels} ${result.checkedModels === 1 ? "model" : "models"}. Fixed ${result.repairs.length} ${result.repairs.length === 1 ? "issue" : "issues"}. ${result.issues.length} ${result.issues.length === 1 ? "issue remains" : "issues remain"}.`,
    );
    write("");
    write(theme.success(theme.heading("Fixed")));
    for (const repair of result.repairs) {
      if (repair.ref) {
        write(`  ${theme.model(repair.ref)}`);
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
    const ref = issue.ref ?? "UMR";
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
    write(
      `${theme.model(ref)}${group.fixable ? ` ${theme.fixable("(Fixable)")}` : ""}`,
    );
    for (const message of group.messages) {
      write(`  ${message}`);
    }
    firstGroup = false;
  }

  if (fixableCount > 0 && result.repairs.length === 0) {
    write("");
    write(`Run ${theme.accent("`umr check --fix`")} to apply safe repairs.`);
  }
}

function printList(
  rows: Awaited<ReturnType<UnifiedModelRegistry["listModels"]>>,
  write: (line: string) => void,
  theme: CliTheme,
): void {
  if (rows.length === 0) {
    write("No models found.");
    return;
  }

  const nameWidth = Math.max(
    "NAME".length,
    ...rows.map((row) => row.name.length),
  );
  const sizeWidth = Math.max(
    "SIZE".length,
    ...rows.map((row) => humanizeBytes(row.totalSizeBytes).length),
  );
  const clientWidth = Math.max(
    "TARGETS".length,
    ...rows.map((row) =>
      row.registrations.length > 0
        ? formatTargetNames(row.registrations).length
        : 1,
    ),
  );
  const statusWidth = Math.max(
    "STATUS".length,
    ...rows.map((row) => row.health.length),
  );
  write(
    `${theme.heading(theme.dim("NAME".padEnd(nameWidth)))}  ${theme.heading(theme.dim("SIZE".padEnd(sizeWidth)))}  ${theme.heading(theme.dim("TARGETS".padEnd(clientWidth)))}  ${theme.heading(theme.dim("STATUS".padEnd(statusWidth)))}`,
  );
  for (const row of rows) {
    const registrations =
      row.registrations.length > 0 ? formatTargetNames(row.registrations) : "-";
    const status =
      row.health === "ok" ? theme.success(row.health) : theme.error(row.health);
    write(
      `${theme.model(row.name.padEnd(nameWidth))}  ${humanizeBytes(row.totalSizeBytes).padEnd(sizeWidth)}  ${registrations === "-" ? theme.dim(registrations.padEnd(clientWidth)) : registrations.padEnd(clientWidth)}  ${status}`,
    );
  }

  const totalBytes = rows.reduce((sum, row) => sum + row.totalSizeBytes, 0);
  write("");
  write(
    `Found ${rows.length} tracked ${rows.length === 1 ? "model" : "models"} for a total of ${humanizeBytes(totalBytes)} on disk.`,
  );
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
    private readonly theme: CliTheme,
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
      this.write(`${this.theme.warning("warn:")} ${event.message}`);
      return;
    }

    if (event.level === "success") {
      this.write(`${this.theme.success("ok:")} ${event.message}`);
      return;
    }

    this.write(`${this.theme.dim("->")} ${event.message}`);
  }
}

function formatHFSelectionState(
  state: HFSelectionState,
  theme: CliTheme,
): string {
  switch (state) {
    case "already-added-to-umr":
      return theme.success("Already Added to UMR");
    case "available-locally-in-hf":
      return theme.accent("Available Locally in HF");
    case "download-required":
      return theme.warning("Download Required");
  }
}

function getHFSelectableFiles(
  manager: UnifiedModelRegistry,
  repo: string,
  inspection: Awaited<ReturnType<UnifiedModelRegistry["inspectHFSource"]>>,
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
        state: "already-added-to-umr",
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
  manager: UnifiedModelRegistry,
  repo: string,
  revision: string | undefined,
  requestedFile: string | undefined,
  interactive: boolean,
  prompts: PromptClient,
  reporter: CliProgressReporter,
  theme: CliTheme,
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
        `GGUF file not found in ${repo}: ${requestedFile}\nAvailable GGUF files:\n${formatGGUFFiles(selectableFiles, theme)}`,
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
      `Multiple GGUF files found in ${repo}.\nUse --file to choose one:\n${formatGGUFFiles(selectableFiles, theme)}`,
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
      hint: formatHFSelectionState(candidate.state, theme),
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
    message: `Download and add to UMR?\nRepo: ${repo}\nFile: ${selected.file}\nRevision: ${resolvedRevision}`,
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

function shouldPrintCommandHelp(argv: string[], command: string): boolean {
  return (
    (argv[0] === command &&
      argv.some((arg) => arg === "--help" || arg === "-h")) ||
    (argv[0] === "help" && argv[1] === command)
  );
}

function isHelpToken(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

function shouldPrintFallbackRootHelp(argv: string[]): boolean {
  const knownCommands = new Set([
    "add",
    "list",
    "show",
    "link",
    "unlink",
    "remove",
    "check",
    "help",
  ]);
  if (argv.length === 0) {
    return false;
  }

  if (argv[0] === "help" && argv[1] && !knownCommands.has(argv[1])) {
    return true;
  }

  return Boolean(
    argv[0] &&
      !knownCommands.has(argv[0]) &&
      argv.some((arg) => isHelpToken(arg)),
  );
}

function shouldPrintUnknownCommandRootHelp(argv: string[]): boolean {
  const knownCommands = new Set([
    "add",
    "list",
    "show",
    "link",
    "unlink",
    "remove",
    "check",
    "help",
  ]);
  const first = argv[0];
  if (!first) {
    return false;
  }

  if (first.startsWith("-")) {
    return false;
  }

  return !knownCommands.has(first);
}

function getCustomHelp(argv: string[], theme: CliTheme): string | null {
  if (shouldPrintRootHelp(argv)) {
    return renderRootHelp(theme);
  }

  if (shouldPrintFallbackRootHelp(argv)) {
    return renderRootHelp(theme);
  }

  if (shouldPrintAddHelp(argv)) {
    return renderAddHelp(theme);
  }

  if (shouldPrintCommandHelp(argv, "link")) {
    return renderLinkHelp(theme, "link");
  }

  if (shouldPrintCommandHelp(argv, "unlink")) {
    return renderLinkHelp(theme, "unlink");
  }

  if (shouldPrintCommandHelp(argv, "list")) {
    return renderListHelp(theme);
  }

  if (shouldPrintCommandHelp(argv, "show")) {
    return renderShowHelp(theme);
  }

  if (shouldPrintCommandHelp(argv, "remove")) {
    return renderRemoveHelp(theme);
  }

  if (shouldPrintCommandHelp(argv, "check")) {
    return renderCheckHelp(theme);
  }

  return null;
}

export async function runCli(
  argv: string[],
  options?: {
    manager?: UnifiedModelRegistry;
    createManager?: () => UnifiedModelRegistry;
    color?: boolean;
    env?: Record<string, string | undefined>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    stdoutRaw?: (chunk: string) => void;
    stderrRaw?: (chunk: string) => void;
    interactive?: boolean;
    prompts?: PromptClient;
    verbose?: boolean;
  },
): Promise<number> {
  const env = options?.env ?? process.env;
  const theme = createTheme({
    color: options?.color,
    env,
    isTTY: Boolean(process.stdout.isTTY),
  });
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
    theme,
    options?.verbose ?? hasVerboseFlag(argv),
  );
  const streamSink = createStreamSink(stderrRaw, stdoutRaw);
  const interactive =
    options?.interactive ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompts = options?.prompts ?? createDefaultPromptClient();
  let manager = options?.manager;
  const getManager = (): UnifiedModelRegistry => {
    manager ??= options?.createManager?.() ?? createDefaultUMR(env);
    return manager;
  };
  let exitCode = 0;

  const customHelp = getCustomHelp(argv, theme);
  if (customHelp) {
    stdoutRaw.write(customHelp);
    stdoutRaw.flush();
    return 0;
  }

  if (shouldPrintUnknownCommandRootHelp(argv)) {
    stdoutRaw.write(renderRootHelp(theme));
    stdoutRaw.flush();
    return 1;
  }

  const program = new Command();
  program
    .name("umr")
    .description("UMR")
    .option("-v, --verbose", "Show detailed progress")
    .version(UMR_VERSION, "--version", "Print version")
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
      "hf <repo> [--file <filename>] [--revision <rev>] [--yes]\n  umr add <path>",
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
              theme,
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
              stdout(
                formatAddedModelMessage(theme, {
                  name: selected.trackedModel.name,
                  alreadyInUMR: true,
                }),
              );
              stdout("");
              stdout(
                `${theme.label("Path:")} ${selected.trackedModel.entryPath}`,
              );
              return;
            }
          }

          const result = await manager.addSource(
            "hf",
            { repo, file, revision: resolvedRevision },
            { reporter, streamSink },
          );
          stdout(
            formatAddedModelMessage(theme, {
              name: result.model.name,
              alreadyInUMR: result.status === "existing",
            }),
          );
          stdout("");
          stdout(`${theme.label("Path:")} ${result.model.entryPath}`);
          return;
        }

        if (value !== undefined) {
          throw new ManagerError("Usage: umr add <path>", {
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
          formatAddedModelMessage(theme, {
            name: result.model.name,
            alreadyInUMR: result.status === "existing",
          }),
        );
        stdout("");
        stdout(`${theme.label("Path:")} ${result.model.entryPath}`);
      },
    );

  program
    .command("list")
    .description("List tracked models")
    .action(async () => {
      printList(await getManager().listModels(), stdout, theme);
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

      const source = describeSource(model);
      stdout(theme.model(model.name));
      stdout(formatDetailLine(theme, "File", model.entryFilename));
      stdout(
        formatDetailLine(theme, "Size", humanizeBytes(model.totalSizeBytes)),
      );
      stdout(
        formatDetailLine(theme, "Source", source.label, {
          valueColor: "accent",
        }),
      );
      if (source.repo) {
        stdout(formatDetailLine(theme, "Repo", source.repo));
      }
      stdout(
        formatDetailLine(theme, "Targets", formatTargets(model), {
          valueColor: formatTargets(model) === "none" ? "dim" : "plain",
        }),
      );
      stdout(formatDetailLine(theme, "Path", model.entryPath));
    });

  program
    .command("link")
    .description("Link a model to a target app")
    .argument("<target>", "Target name")
    .argument("<model>", "Model selector")
    .action(async (target: string, selector: string) => {
      const registry = getManager();
      const model = registry.getModel(selector);
      await registry.link(target, selector, {
        reporter,
        streamSink,
      });
      stdout(
        `${theme.success("Linked model")} ${theme.model(model.name)} ${theme.success("to")} ${theme.accent(formatClientName(target))}`,
      );
    });

  program
    .command("unlink")
    .description("Remove a model link from a target app")
    .argument("<target>", "Target name")
    .argument("<model>", "Model selector")
    .action(async (target: string, selector: string) => {
      const registry = getManager();
      const model = registry.getModel(selector);
      await registry.unlink(target, selector, { reporter, streamSink });
      stdout(
        `${theme.success("Unlinked model")} ${theme.model(model.name)} ${theme.success("from")} ${theme.accent(formatClientName(target))}`,
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
      stdout(
        `${theme.success("Removed model")} ${theme.model(model.name)} ${theme.success("from UMR")}`,
      );
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
      printCheck(result, stdout, theme);
      if (result.issues.length > 0) {
        exitCode = 3;
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    stdoutRaw.flush();
    stderrRaw.flush();

    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const managerError = asManagerError(error);
    stderr(`${theme.error("error:")} ${managerError.message}`);
    return managerError.exitCode;
  } finally {
    stdoutRaw.flush();
    stderrRaw.flush();
  }
}
