/** Nothing in a test run may touch the real ~/.pi/agent: metrics, stores and
 * lcm.json all resolve through os.homedir(). HOME moves to a per-run temp dir
 * before any test file loads, and LCM_TEST_GUARD makes a write outside that dir
 * that does not read that config leaves HOME where it was. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUnderTempDir, lcmHomePath } from "../src/home-paths.ts";

const home = mkdtempSync(join(tmpdir(), "lcm-test-home-"));
process.env.HOME = home;
process.env.LCM_TEST_GUARD = "1";

// The path the extension would write, not the env var: a driver that caches
// os.homedir() would make an env-only check pass while writes went elsewhere.
if (!isUnderTempDir(lcmHomePath("lcm.json"))) {
  throw new Error(
    `LCM test setup failed: home paths resolve outside ${tmpdir()}. A test run would write to the real ~/.pi/agent.`,
  );
}
