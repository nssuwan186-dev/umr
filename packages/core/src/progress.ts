import type { ProgressReporter } from "./types";

export async function emitInfo(
  reporter: ProgressReporter | undefined,
  message: string,
): Promise<void> {
  await reporter?.emit({ level: "info", message });
}

export async function emitSuccess(
  reporter: ProgressReporter | undefined,
  message: string,
): Promise<void> {
  await reporter?.emit({ level: "success", message });
}

export async function emitWarning(
  reporter: ProgressReporter | undefined,
  message: string,
): Promise<void> {
  await reporter?.emit({ level: "warning", message });
}
