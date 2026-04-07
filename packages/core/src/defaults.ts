import { RegistrarAdapterRegistry, SourceAdapterRegistry } from "./adapters";
import { VirtualModelRegistry } from "./manager";
import { resolveDataPaths } from "./paths";
import { LMStudioRegistrarAdapter } from "./registrars/lmstudio";
import { OllamaRegistrarAdapter } from "./registrars/ollama";
import { BunCommandRunner } from "./shell";
import { HFSourceAdapter } from "./sources/hf-source";
import { PathSourceAdapter } from "./sources/path-source";

export function createDefaultVMR(
  env: Record<string, string | undefined> = process.env,
): VirtualModelRegistry {
  const commandRunner = new BunCommandRunner();
  const dataPaths = resolveDataPaths(env);
  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());
  sourceAdapters.register(new HFSourceAdapter(commandRunner));

  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register(
    new LMStudioRegistrarAdapter(commandRunner, dataPaths, env),
  );
  registrarAdapters.register(
    new OllamaRegistrarAdapter(commandRunner, dataPaths),
  );

  return new VirtualModelRegistry({
    dataPaths,
    sourceAdapters,
    registrarAdapters,
  });
}
