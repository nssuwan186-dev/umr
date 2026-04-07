import { homedir } from "node:os";
import path from "node:path";

export interface DataPaths {
  root: string;
  registryPath: string;
  modelsDir: string;
  tmpDir: string;
  importsTmpDir: string;
  adaptersTmpDir: string;
}

export function resolveDataRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.VMR_HOME?.trim();
  if (override) {
    return path.resolve(override);
  }

  return path.join(homedir(), ".vmr");
}

export function resolveDataPaths(
  env: Record<string, string | undefined> = process.env,
): DataPaths {
  const root = resolveDataRoot(env);

  return {
    root,
    registryPath: path.join(root, "registry.sqlite"),
    modelsDir: path.join(root, "models"),
    tmpDir: path.join(root, "tmp"),
    importsTmpDir: path.join(root, "tmp", "imports"),
    adaptersTmpDir: path.join(root, "tmp", "adapters"),
  };
}
