import { expect, test } from "bun:test";

import { resolveDataPaths, resolveDataRoot } from "../src/paths";

test("resolveDataRoot uses override when set", () => {
  expect(resolveDataRoot({ UMR_HOME: "/tmp/custom-umr" })).toBe(
    "/tmp/custom-umr",
  );
});

test("resolveDataPaths builds expected layout", () => {
  const paths = resolveDataPaths({
    UMR_HOME: "/tmp/custom-umr",
  });
  expect(paths.modelsDir).toBe("/tmp/custom-umr/models");
  expect(paths.adaptersTmpDir).toBe("/tmp/custom-umr/tmp/adapters");
});
