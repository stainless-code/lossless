import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const dir = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(dir, "run-e2e.sh"), "utf8");

describe("run-e2e.sh", () => {
  it("scopes sidecars to the scratch DSH_HOME", () => {
    expect(script).toContain('export DSH_HOME="/tmp/e2e-dsh"');
    expect(script).toContain('SIDECAR_DIR="$DSH_HOME/lossless"');
    expect(script).not.toContain("/tmp/.lossless");
  });

  it("asserts the probed sidecars in the scratch dir", () => {
    expect(script).toContain('sidecars=("$SIDECAR_DIR"/*.sqlite)');
    expect(script).toContain("no sidecar sqlite files in $SIDECAR_DIR");
  });
});
