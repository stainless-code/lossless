import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOW_REAL_HOME_FLAG, isUnderTempDir, lcmHomePath } from "lossless-core";
import { metricsPath } from "lossless-core";
import { test } from "vite-plus/test";

import { testHomePath } from "../../core/test/support/temp-home.ts";
import { lcmConfigBackupPath, lcmConfigPath, writeLcmConfig } from "../src/ui/config-io.ts";

const OUTSIDE_HOME = join(tmpdir(), "..", "lcm-not-the-temp-home");

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withOutsideHome(body: () => void): void {
  const original = process.env.HOME;
  process.env.HOME = OUTSIDE_HOME;
  try {
    body();
  } finally {
    setEnv("HOME", original);
  }
}

test("isolation: the runner moved HOME into a temp dir", () => {
  assert.ok(
    isUnderTempDir(process.env.HOME ?? ""),
    `HOME is ${process.env.HOME}, so this run can reach the real ~/.pi/agent`,
  );
});

test("isolation: home paths resolve inside the test home", () => {
  assert.equal(lcmConfigPath(), testHomePath(".pi", "agent", "lcm.json"));
  assert.equal(metricsPath(), testHomePath(".pi", "agent", "lcm", "metrics.jsonl"));
  assert.equal(lcmConfigBackupPath(), `${lcmConfigPath()}.bak`);
});

test("isolation: a write outside the temp home is refused, not redirected", () => {
  withOutsideHome(() => {
    assert.throws(() => lcmConfigPath(), /LCM refused/);
    assert.throws(() => writeLcmConfig({ smartZone: 110_000 }), /LCM refused/);
    assert.throws(() => metricsPath(), /LCM refused/);
  });
  assert.equal(
    existsSync(join(OUTSIDE_HOME, ".pi", "agent", "lcm.json")),
    false,
    "a refused write created the file anyway",
  );
});

test("isolation: the guard holds without the setup flag", () => {
  const flag = process.env.LCM_TEST_GUARD;
  delete process.env.LCM_TEST_GUARD;
  try {
    withOutsideHome(() => {
      // A process the setup did not reach still carries a test signal, which is
      // what keeps the guard from depending on the config it defends.
      assert.throws(() => lcmHomePath("lcm.json"), /looks like a test run/);
    });
  } finally {
    setEnv("LCM_TEST_GUARD", flag);
  }
});

test("isolation: the escape hatch still reaches a real path", () => {
  process.env[ALLOW_REAL_HOME_FLAG] = "1";
  try {
    withOutsideHome(() => {
      assert.equal(lcmConfigPath(), join(OUTSIDE_HOME, ".pi", "agent", "lcm.json"));
    });
  } finally {
    delete process.env[ALLOW_REAL_HOME_FLAG];
  }
});
