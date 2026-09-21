import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { isUnderTempDir } from "../../src/home-paths.ts";

/** A path under the temp home `test/setup.ts` pointed HOME at. Reading the path
 * lazily is what keeps a runner that skipped the setup from capturing it at
 * import time. */
export function testHomePath(...segments: string[]): string {
  const home = process.env.HOME ?? "";
  assert.ok(
    isUnderTempDir(home),
    `HOME is ${home || "(unset)"}, which is not a temp dir: test/setup.ts did not run.`,
  );
  return join(home, ...segments);
}

/** The only way a test deletes anything. A `..` in the segments still has to
 * land inside the temp home. */
export function removeTestPath(...segments: string[]): void {
  const path = testHomePath(...segments);
  assert.ok(isUnderTempDir(path), `refusing to delete a path outside the test home: ${path}`);
  rmSync(path, { force: true });
}
