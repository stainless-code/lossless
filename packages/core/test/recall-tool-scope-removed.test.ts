import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { ingestEntries } from "../src/ingest.ts";
import { grepView, toolScopeMessageIds } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";

function hitIds(view: ReturnType<typeof grepView>): string[] {
  assert.equal(view.ok, true);
  return view.text
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith("["))
    .map((l) => l.slice(1, l.indexOf("]")));
}

test("toolScope: a removed result naming another tool does not end the visible scope", () => {
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      {
        entryId: "a00",
        role: "assistant",
        text: 'tool-call: read {"path": "/a"}',
        timestamp: 1,
      },
      { entryId: "r00", role: "toolResult", text: "firstword body here", timestamp: 2 },
      {
        entryId: "r01",
        role: "toolResult",
        text: 'tool-call: bash {"cmd": "ls"}\nsecondword',
        timestamp: 3,
      },
      { entryId: "r02", role: "toolResult", text: "thirdword body here", timestamp: 4 },
    ]);
    store.setRemoved(["r01"], 999);
    const byEntry = new Map(store.allMessages().map((m) => [m.entryId, m.id]));
    const visible = toolScopeMessageIds(store, "read");
    assert.ok(visible.has(byEntry.get("a00")!), "call row opens scope");
    assert.ok(visible.has(byEntry.get("r00")!), "plain result stays in");
    assert.ok(!visible.has(byEntry.get("r01")!), "removed row stays out");
    assert.ok(
      visible.has(byEntry.get("r02")!),
      "visible continuation after a removed other-tool row stays in",
    );
    const unfiltered = toolScopeMessageIds(store, "read", { includeRemoved: true });
    assert.ok(unfiltered.has(byEntry.get("a00")!), "unfiltered call row opens scope");
    assert.ok(unfiltered.has(byEntry.get("r00")!), "unfiltered plain result stays in");
    assert.ok(!unfiltered.has(byEntry.get("r01")!), "other-tool row ends scope");
    assert.ok(!unfiltered.has(byEntry.get("r02")!), "rows after the other tool stay out");
    const kept = hitIds(grepView(store, redactSecrets, { query: "thirdword", toolName: "read" }));
    assert.deepEqual(kept, ["r02"]);
  } finally {
    store.close();
  }
});
