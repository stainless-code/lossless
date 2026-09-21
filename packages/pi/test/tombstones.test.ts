import assert from "node:assert/strict";

import { redactSecrets } from "lossless-core";
import { LcmStore } from "lossless-core";
import { ingestEntries } from "lossless-core";
import { expandView, grepView } from "lossless-core";
import { test } from "vite-plus/test";

import { createGrepTool } from "../src/tools/recall.ts";

function seeded(): { store: LcmStore; leaf: number } {
  const store = new LcmStore(":memory:");
  ingestEntries(store, [
    { entryId: "e0", role: "user", text: "kept on the active path", timestamp: 0 },
    { entryId: "e1", role: "assistant", text: "the abandoned decision", timestamp: 1 },
  ]);
  const leaf = store.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    messageIds: store.messagesInSpan("e0", "e1").map((m) => m.id),
  }).id;
  return { store, leaf };
}

test("tombstones: marking is idempotent, reversible, and counted per change", () => {
  const { store } = seeded();
  assert.equal(store.setRemoved(["e1"], 100), 1, "one row changed");
  assert.equal(store.setRemoved(["e1"], 200), 0, "already marked, so no change");
  assert.equal(store.removedMessageCount(), 1);
  assert.equal(store.stats().removedMessages, 1);
  assert.equal(store.setRemoved(["e0", "e1"], null), 1, "only the marked row is cleared");
  assert.equal(store.removedMessageCount(), 0);
  assert.equal(store.setRemoved([], 100), 0, "no ids, no write");
  store.close();
});

test("tombstones: search skips a removed message unless it is asked for", () => {
  const { store } = seeded();
  store.setRemoved(["e1"], 100);
  assert.deepEqual(store.grep("abandoned"), [], "excluded by default");
  const withRemoved = store.grep("abandoned", { includeRemoved: true });
  assert.equal(withRemoved.length, 1);
  assert.equal(withRemoved[0]!.removed, true);
  assert.equal(store.grep("kept")[0]!.removed, undefined, "an active hit carries no flag");
  store.close();
});

test("grepView: a removed hit is labelled, and an all-removed result says so", () => {
  const { store } = seeded();
  store.setRemoved(["e1"], 100);
  const hidden = grepView(store, redactSecrets, { query: "abandoned" });
  assert.ok(hidden.ok);
  if (!hidden.ok) return;
  assert.equal(
    hidden.text,
    'Match(es) for "abandoned" exist on a branch that left the active path; pass include_removed to read them.',
  );
  assert.deepEqual(hidden.details, { hits: 0, removed: 1 });

  const shown = grepView(store, redactSecrets, { query: "abandoned", includeRemoved: true });
  assert.ok(shown.ok);
  if (!shown.ok) return;
  assert.equal(
    shown.text,
    "Found 1 match(es):\n[e1] (assistant) #1 [removed] the abandoned decision",
  );
  assert.deepEqual(shown.details, { hits: 1, offset: 0, total: 1 });

  const active = grepView(store, redactSecrets, { query: "kept" });
  assert.ok(active.ok);
  if (!active.ok) return;
  assert.equal(active.text, "Found 1 match(es):\n[e0] (user) #1 kept on the active path");
  store.close();
});

test("expandView: a removed message is read, with a marker that names its state", () => {
  const { store, leaf } = seeded();
  store.setRemoved(["e1"], 100);
  const view = expandView(store, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e1",
    charOffset: 0,
    maxChars: 400,
  });
  assert.ok(view.ok);
  if (!view.ok) return;
  assert.equal(
    view.text,
    "[lcm:removed e1 is not on the active branch; text retained]\n" +
      "[e1] (assistant) chars 0..22 of 22\n\n" +
      "the abandoned decision",
  );
  assert.equal(view.details["removed"], true);
  const active = expandView(store, redactSecrets, {
    mode: "message",
    id: leaf,
    entryId: "e0",
    charOffset: 0,
    maxChars: 400,
  });
  assert.ok(active.ok);
  if (!active.ok) return;
  assert.equal(active.text.includes("[lcm:removed"), false);
  assert.equal("removed" in active.details, false);
  store.close();
});

test("grep tool: include_removed reaches the view and the metric stays a miss", async () => {
  const { store } = seeded();
  store.setRemoved(["e1"], 100);
  const tool = createGrepTool({ store: () => store, session: () => "s1", redact: redactSecrets });
  const hidden = await tool.execute("t", { query: "abandoned" });
  assert.equal(
    hidden.content[0]!.text,
    'Match(es) for "abandoned" exist on a branch that left the active path; pass include_removed to read them.',
  );
  assert.deepEqual(hidden.details, { hits: 0, removed: 1 });
  const shown = await tool.execute("t", { query: "abandoned", include_removed: true });
  assert.ok(shown.content[0]!.text.includes("[removed] the abandoned decision"));
  store.close();
});
