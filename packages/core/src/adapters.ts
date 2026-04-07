import { ManagerError } from "./errors";
import type { RegistrarAdapter, SourceAdapter } from "./types";

export class SourceAdapterRegistry {
  #adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    this.#adapters.set(adapter.kind(), adapter);
  }

  get(kind: string): SourceAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) {
      throw new ManagerError(`Unknown source adapter: ${kind}`, {
        code: "unknown-source",
        exitCode: 2,
      });
    }

    return adapter;
  }

  has(kind: string): boolean {
    return this.#adapters.has(kind);
  }

  all(): SourceAdapter[] {
    return [...this.#adapters.values()];
  }
}

export class RegistrarAdapterRegistry {
  #adapters = new Map<string, RegistrarAdapter>();

  register(adapter: RegistrarAdapter): void {
    this.#adapters.set(adapter.client(), adapter);
  }

  get(client: string): RegistrarAdapter {
    const adapter = this.#adapters.get(client);
    if (!adapter) {
      throw new ManagerError(`Unknown registrar adapter: ${client}`, {
        code: "unknown-client",
        exitCode: 2,
      });
    }

    return adapter;
  }

  all(): RegistrarAdapter[] {
    return [...this.#adapters.values()];
  }
}
