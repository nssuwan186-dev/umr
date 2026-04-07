import { expect, test } from "bun:test";

import {
  RegistrarAdapterRegistry,
  SourceAdapterRegistry,
} from "../src/adapters";

test("source adapter registry dispatches by kind", () => {
  const registry = new SourceAdapterRegistry();
  const adapter = {
    kind: () => "fake",
    describe: () => ({ kind: "fake", payload: {} }),
    resolve: async () => ({
      format: "gguf" as const,
      metadata: {},
      provenance: {},
      storeStrategy: "copy" as const,
      entryRelPath: "fake.gguf",
      members: [{ sourcePath: "/tmp/fake.gguf", relPath: "fake.gguf" }],
    }),
  };

  registry.register(adapter);
  expect(registry.get("fake")).toBe(adapter);
  expect(registry.has("fake")).toBeTrue();
});

test("registrar adapter registry dispatches by client", () => {
  const registry = new RegistrarAdapterRegistry();
  const adapter = {
    client: () => "fake",
    register: async () => ({ clientRef: "fake", state: {} }),
    unregister: async () => {},
    check: async () => ({ ok: true, issues: [] }),
  };

  registry.register(adapter);
  expect(registry.get("fake")).toBe(adapter);
});
