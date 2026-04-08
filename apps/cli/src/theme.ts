import { createColors } from "picocolors";

export interface CliTheme {
  readonly enabled: boolean;
  accent(text: string): string;
  addCommand(text: string): string;
  blue(text: string): string;
  command(text: string): string;
  description(text: string): string;
  dim(text: string): string;
  error(text: string): string;
  fixable(text: string): string;
  flag(text: string): string;
  heading(text: string): string;
  label(text: string): string;
  model(text: string): string;
  muted(text: string): string;
  orange(text: string): string;
  orangeCommand(text: string): string;
  plain(text: string): string;
  purple(text: string): string;
  product(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  blueCommand(text: string): string;
}

function resolveColorEnabled(
  override: boolean | undefined,
  env: Record<string, string | undefined>,
  isTTY: boolean,
): boolean {
  if (typeof override === "boolean") {
    return override;
  }

  if (env.NO_COLOR !== undefined) {
    return false;
  }

  const forceColor = env.FORCE_COLOR?.trim();
  if (forceColor) {
    return forceColor !== "0";
  }

  return isTTY;
}

export function createTheme(options?: {
  color?: boolean;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}): CliTheme {
  const env = options?.env ?? process.env;
  const enabled = resolveColorEnabled(
    options?.color,
    env,
    options?.isTTY ?? Boolean(process.stdout.isTTY),
  );
  const colors = createColors(enabled);
  const orange = (text: string) =>
    enabled ? `\u001b[38;5;214m${text}\u001b[39m` : text;

  return {
    enabled,
    accent: (text) => colors.cyan(text),
    addCommand: (text) => colors.bold(colors.magenta(text)),
    blue: (text) => colors.blue(text),
    blueCommand: (text) => colors.bold(colors.blue(text)),
    command: (text) => colors.bold(colors.cyan(text)),
    description: (text) => colors.dim(text),
    dim: (text) => colors.dim(text),
    error: (text) => colors.red(text),
    fixable: (text) => colors.yellow(text),
    flag: (text) => colors.cyan(text),
    heading: (text) => colors.bold(text),
    label: (text) => colors.dim(text),
    model: (text) => colors.bold(text),
    muted: (text) => colors.dim(text),
    orange,
    orangeCommand: (text) => colors.bold(orange(text)),
    plain: (text) => text,
    purple: (text) => colors.magenta(text),
    product: (text) => colors.bold(colors.magenta(text)),
    success: (text) => colors.green(text),
    warning: (text) => colors.yellow(text),
  };
}
