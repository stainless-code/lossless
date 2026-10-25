import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { dumpSidecar } from "../src/sidecar-dump.ts";

function seedStore(path: string): void {
  const store = new LcmStore(path);
  ingestEntries(store, [
    {
      entryId: "s1:1",
      role: "user",
      text: "dump me",
      timestamp: Date.now(),
    },
  ]);
  store.close();
}

describe("sidecar dump", () => {
  it("reports a named skip for a missing sidecar", () => {
    const result = dumpSidecar({
      path: join(mkdtempSync(join(tmpdir(), "dump-")), "missing.sqlite"),
      sessionId: "missing",
      redact: (text) => text,
    });
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") assert.equal(result.reason, "missing");
  });

  it("dumps a stored session with metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "dump-"));
    const path = join(dir, "ses_dump.sqlite");
    seedStore(path);
    const result = dumpSidecar({
      path,
      sessionId: "ses_dump",
      redact: (text) => text,
    });
    expect(result.status).toBe("dumped");
    if (result.status === "dumped") expect(result.text).toContain("LCM sidecar dump: ses_dump");
  });
});
