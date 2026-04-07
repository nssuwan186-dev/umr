import { expect, test } from "bun:test";

import { resolveDataPaths, resolveDataRoot } from "../src/paths";

test("resolveDataRoot uses override when set", () => {
  expect(resolveDataRoot({ VMR_HOME: "/tmp/custom-vmr" })).toBe(
    "/tmp/custom-vmr",
  );
});

test("resolveDataPaths builds expected layout", () => {
  const paths = resolveDataPaths({
    VMR_HOME: "/tmp/custom-vmr",
  });
  expect(paths.modelsDir).toBe("/tmp/custom-vmr/models");
  expect(paths.adaptersTmpDir).toBe("/tmp/custom-vmr/tmp/adapters");
});
