import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { ManagerError } from "./errors";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<CommandResult>;
  commandExists(command: string): Promise<boolean>;
}

export class BunCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[] = [],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options?.cwd,
      env: {
        ...process.env,
        ...options?.env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  }

  async commandExists(command: string): Promise<boolean> {
    if (command.includes(path.sep)) {
      try {
        await access(command, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }

    const pathEnv = process.env.PATH ?? "";
    for (const segment of pathEnv.split(path.delimiter)) {
      const candidate = path.join(segment, command);
      try {
        await access(candidate, fsConstants.X_OK);
        return true;
      } catch {}
    }

    return false;
  }
}

export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0) {
    throw new ManagerError(
      `Command failed: ${command} ${args.join(" ")}`.trim(),
      {
        code: "command-failed",
        cause: result.stderr || result.stdout,
        exitCode: 1,
      },
    );
  }

  return result;
}
