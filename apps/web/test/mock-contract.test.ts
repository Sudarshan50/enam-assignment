import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

describe("mock fixtures", () => {
  it("pass scripts/check-mocks.ts against the shared contracts", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/check-mocks.ts"], {
      cwd: webRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/✓ \d+ mock checks passed/);
  }, 60_000);
});
