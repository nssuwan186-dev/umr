import {
  type CheckResult,
  type ModelDetails,
  type ProgressEvent,
  type VirtualModelRegistry,
  asManagerError,
  createDefaultVMR,
} from "@vmr/core";

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

function usage(): string {
  return `Usage:
  vmr add hf <repo> [--file <filename>] [--revision <rev>]
  vmr add <path>
  vmr list
  vmr show <model> [--path]
  vmr register lmstudio <model>
  vmr register ollama <model>
  vmr unregister lmstudio <model>
  vmr unregister ollama <model>
  vmr remove <model>
  vmr check [--fix]`;
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

export async function runCli(
  argv: string[],
  options?: {
    manager?: VirtualModelRegistry;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  },
): Promise<number> {
  const manager = options?.manager ?? createDefaultVMR();
  const stdout = options?.stdout ?? ((line: string) => console.log(line));
  const stderr = options?.stderr ?? ((line: string) => console.error(line));
  const reporter = new CliProgressReporter(stderr);

  try {
    const [command, ...rest] = argv;
    if (!command || command === "--help" || command === "-h") {
      stdout(usage());
      return 0;
    }

    if (command === "add") {
      const [sourceOrPath, ...args] = rest;
      if (!sourceOrPath) {
        throw new Error("Missing source or path");
      }

      const explicitSourceKinds = manager.listExplicitSourceKinds();
      if (explicitSourceKinds.includes(sourceOrPath)) {
        if (sourceOrPath === "hf") {
          const repo = args[0];
          if (!repo) {
            throw new Error("Missing Hugging Face repo");
          }

          let file: string | undefined;
          let revision: string | undefined;
          for (let index = 1; index < args.length; index += 1) {
            if (args[index] === "--file") {
              file = args[index + 1];
              index += 1;
            } else if (args[index] === "--revision") {
              revision = args[index + 1];
              index += 1;
            }
          }

          const result = await manager.addSource(
            "hf",
            { repo, file, revision },
            { reporter },
          );
          stdout(
            `${result.status}: ${result.model.name} (${result.model.ref})`,
          );
          stdout(result.model.entryPath);
          return 0;
        }

        throw new Error(`Unsupported source keyword: ${sourceOrPath}`);
      }

      const result = await manager.addSource(
        "path",
        { path: sourceOrPath },
        { reporter },
      );
      stdout(`${result.status}: ${result.model.name} (${result.model.ref})`);
      stdout(result.model.entryPath);
      return 0;
    }

    if (command === "list") {
      printList(await manager.listModels(), stdout);
      return 0;
    }

    if (command === "show") {
      const selector = rest[0];
      if (!selector) {
        throw new Error("Missing model selector");
      }

      const pathOnly = rest.includes("--path");
      const model = manager.getModel(selector);
      if (pathOnly) {
        stdout(model.entryPath);
        return 0;
      }

      stdout(`name: ${model.name}`);
      stdout(`ref: ${model.ref}`);
      stdout(`filename: ${model.entryFilename}`);
      stdout(`path: ${model.entryPath}`);
      stdout(`content-digest: ${model.contentDigest}`);
      stdout(`size: ${model.totalSizeBytes}`);
      stdout(`sources:\n${formatSources(model)}`);
      stdout(`registrations:\n${formatRegistrations(model)}`);
      return 0;
    }

    if (command === "register") {
      const [client, selector] = rest;
      if (!client || !selector) {
        throw new Error("Usage: vmr register <client> <model>");
      }

      const registration = await manager.register(client, selector, {
        reporter,
      });
      stdout(
        `registered ${selector} with ${client}: ${registration.clientRef}`,
      );
      return 0;
    }

    if (command === "unregister") {
      const [client, selector] = rest;
      if (!client || !selector) {
        throw new Error("Usage: vmr unregister <client> <model>");
      }

      await manager.unregister(client, selector, { reporter });
      stdout(`unregistered ${selector} from ${client}`);
      return 0;
    }

    if (command === "remove") {
      const selector = rest[0];
      if (!selector) {
        throw new Error("Missing model selector");
      }

      await manager.remove(selector, { reporter });
      stdout(`removed ${selector}`);
      return 0;
    }

    if (command === "check") {
      const fix = rest.includes("--fix");
      const result = await manager.check({ fix, reporter });
      printCheck(result, stdout);
      return result.issues.length === 0 ? 0 : 3;
    }

    stderr(usage());
    return 1;
  } catch (error) {
    const managerError = asManagerError(error);
    stderr(managerError.message);
    return managerError.exitCode;
  }
}
