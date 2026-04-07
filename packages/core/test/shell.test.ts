import { expect, test } from "bun:test";

import { BunCommandRunner } from "../src/shell";

test("runStreaming forwards stdout and stderr chunks while buffering final output", async () => {
  const runner = new BunCommandRunner();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runner.runStreaming(
    "bun",
    [
      "-e",
      [
        'process.stdout.write("hello");',
        "await Bun.sleep(5);",
        'process.stderr.write("warn");',
        "await Bun.sleep(5);",
        'process.stdout.write(" world");',
      ].join(" "),
    ],
    {
      onStdoutChunk(chunk) {
        stdoutChunks.push(chunk);
      },
      onStderrChunk(chunk) {
        stderrChunks.push(chunk);
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("hello world");
  expect(result.stderr).toBe("warn");
  expect(stdoutChunks.join("")).toBe("hello world");
  expect(stderrChunks.join("")).toBe("warn");
});

test("run still buffers output without requiring stream callbacks", async () => {
  const runner = new BunCommandRunner();
  const result = await runner.run("bun", [
    "-e",
    'process.stdout.write("ok"); process.stderr.write("warn");',
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("ok");
  expect(result.stderr).toBe("warn");
});
