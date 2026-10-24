import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { Sidecars } from "../src/sidecars.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-sidecars-"));
}

describe("Sidecars", () => {
  it("creates its directory owner-only", () => {
    const root = tempDir();
    const dir = join(root, "sidecars");
    const sidecars = new Sidecars(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    sidecars.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("repairs an existing group-readable directory to owner-only", () => {
    const root = tempDir();
    const dir = join(root, "sidecars");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const sidecars = new Sidecars(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    sidecars.close();
    rmSync(root, { recursive: true, force: true });
  });
});
