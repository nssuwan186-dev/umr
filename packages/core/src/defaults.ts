import { RegistrarAdapterRegistry, SourceAdapterRegistry } from "./adapters";
import { UnifiedModelRegistry } from "./manager";
import { resolveDataPaths } from "./paths";
import { JanRegistrarAdapter } from "./registrars/jan";
import { LMStudioRegistrarAdapter } from "./registrars/lmstudio";
import { OllamaRegistrarAdapter } from "./registrars/ollama";
import { BunCommandRunner } from "./shell";
import { HFSourceAdapter } from "./sources/hf-source";
import { PathSourceAdapter } from "./sources/path-source";

export function createDefaultUMR(
  env: Record<string, string | undefined> = process.env,
): UnifiedModelRegistry {
  const commandRunner = new BunCommandRunner();
  const dataPaths = resolveDataPaths(env);
  const sourceAdapters = new SourceAdapterRegistry();
  sourceAdapters.register(new PathSourceAdapter());
  sourceAdapters.register(new HFSourceAdapter(commandRunner));

  const registrarAdapters = new RegistrarAdapterRegistry();
  registrarAdapters.register(
    new LMStudioRegistrarAdapter(commandRunner, dataPaths, env),
  );
  registrarAdapters.register(new JanRegistrarAdapter(env));
  registrarAdapters.register(
    new OllamaRegistrarAdapter(commandRunner, dataPaths),
  );

  return new UnifiedModelRegistry({
    dataPaths,
    sourceAdapters,
    registrarAdapters,
  });
}
