export class ManagerError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(
    message: string,
    options?: { code?: string; exitCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ManagerError";
    this.code = options?.code ?? "manager-error";
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function asManagerError(error: unknown): ManagerError {
  if (error instanceof ManagerError) {
    return error;
  }

  if (error instanceof Error) {
    return new ManagerError(error.message, { cause: error });
  }

  return new ManagerError("Unknown error", { cause: error });
}
