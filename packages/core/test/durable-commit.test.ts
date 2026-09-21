import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test, vi } from "vite-plus/test";

import { EXPORT_VERSION, type ExportRow } from "../src/export.ts";
import { importTranscript } from "../src/import.ts";
import { ingestEntries } from "../src/ingest.ts";
import { checkIntegrity } from "../src/integrity.ts";
import { LcmStore, SCHEMA_VERSION, type InsertSummaryInput } from "../src/store.ts";
import { holdRun, leaveCrashedRun } from "./support/run-holder.ts";

interface Fixture {
  dir: string;
  path: string;
  store: LcmStore;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "lcm-durable-"));
  const path = join(dir, "store.db");
  const store = new LcmStore(path);
  ingestEntries(store, [
    { entryId: "e0", role: "user", text: "first message", timestamp: 0 },
    { entryId: "e1", role: "assistant", text: "second message", timestamp: 1 },
  ]);
  return { dir, path, store };
}

function leaf(over: Partial<InsertSummaryInput> = {}): InsertSummaryInput {
  return {
    kind: "leaf",
    text: "leaf over e0..e1",
    tokens: 4,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    messageIds: [1, 2],
    ...over,
  };
}

test("a pending node is invisible to every plain read and visible to its run", () => {
  const f = fixture();
  const s = f.store;
  const { token } = s.openRun();
  const view = s.forRun(token);
  const inserted = view.insertSummary(leaf());
  assert.equal(inserted.created, true);

  assert.equal(s.stats().summaries, 0, "a pending node is not memory");
  assert.equal(s.allSummaries().length, 0);
  assert.equal(s.getSummary(inserted.id), undefined, "a by-id read is committed-only");
  assert.equal(s.uncoveredMessagesInSpan("e0", "e1").length, 2, "its messages stay uncovered");
  assert.equal(s.frontier("e0", "e1").length, 0, "no node over its span is current");
  assert.equal(s.integritySnapshot().uncoveredMessages, 2);

  assert.equal(view.getSummary(inserted.id)?.text, "leaf over e0..e1", "the run sees its own row");
  assert.equal(view.frontier("e0", "e1").length, 1);
  assert.equal(view.uncoveredMessagesInSpan("e0", "e1").length, 0, "the run sees it as covered");

  assert.deepEqual(s.commitRun(token), { committed: 1, dropped: 0 });
  assert.equal(s.stats().summaries, 1, "the commit is what makes the row memory");
  assert.equal(s.uncoveredMessagesInSpan("e0", "e1").length, 0);
  assert.equal(s.frontier("e0", "e1").length, 1);
  assert.equal(s.integritySnapshot().uncoveredMessages, 0);
  s.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a commit drops a node whose child no longer resolves", () => {
  const f = fixture();
  const s = f.store;
  const { token } = s.openRun();
  const view = s.forRun(token);
  const child = view.insertSummary(leaf());
  const parent = view.insertSummary({
    kind: "condensed",
    text: "parent over the leaf",
    tokens: 3,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e1",
    childSummaryIds: [child.id],
  });
  const raw = new DatabaseSync(f.path);
  raw.exec(`DELETE FROM summaries WHERE id = ${child.id}`);
  raw.close();

  assert.deepEqual(
    s.commitRun(token),
    { committed: 0, dropped: 1 },
    "a parent that lost its child cannot commit",
  );
  assert.equal(s.stats().summaries, 0);
  assert.equal(s.getSummary(parent.id), undefined);
  s.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a commit clears the run a row was written under", () => {
  const f = fixture();
  const s = f.store;
  const { token } = s.openRun();
  const inserted = s.forRun(token).insertSummary(leaf());
  assert.deepEqual(s.commitRun(token), { committed: 1, dropped: 0 });

  const raw = new DatabaseSync(f.path);
  const row = raw.prepare("SELECT status, run FROM summaries WHERE id = ?").get(inserted.id) as {
    status: string;
    run: string | null;
  };
  assert.equal(row.status, "committed");
  assert.equal(row.run, null, "memory names no run, so no run record has to outlive it");
  raw.close();
  s.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a pending node a dead process left is reaped by the next run", () => {
  const f = fixture();
  leaveCrashedRun(f.path, { first: "e0", last: "e1" });
  const reader = new LcmStore(f.path);
  assert.equal(reader.stats().summaries, 0, "no reader can see it");

  const next = new LcmStore(f.path);
  assert.equal(next.openRun().dropped, 1, "the next run reaps what the dead process left");
  assert.equal(next.stats().summaries, 0);
  assert.equal(
    next.uncoveredMessagesInSpan("e0", "e1").length,
    2,
    "the span is free again, so the next pass summarizes it",
  );
  assert.equal(next.openRun().dropped, 0, "and there is nothing left to reap");
  next.close();
  reader.close();
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a run another process holds is not reaped, and is reaped when it exits", async () => {
  const f = fixture();
  const holder = await holdRun(f.path, { first: "e0", last: "e1" });
  try {
    const peer = new LcmStore(f.path);
    const run = peer.openRun();
    assert.equal(run.dropped, 0, "a run a live process holds is not reaped");

    const collision = peer.forRun(run.token).insertSummary(leaf({ text: "a peer's attempt" }));
    assert.equal(collision.created, false, "the live run still owns its span");
    assert.equal(collision.own, false, "and the peer may not count it");
    assert.equal(collision.foreignLive, true, "which is what the collision reports");
    peer.abandonRun(run.token);

    await holder.stop();
    const next = new LcmStore(f.path);
    assert.equal(next.openRun().dropped, 1, "a run whose process exited is reaped");
    assert.equal(next.stats().summaries, 0);
    next.close();
    peer.close();
  } finally {
    await holder.stop();
  }
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("another handle in this process cannot reap a run it did not open", () => {
  const f = fixture();
  const a = new LcmStore(f.path);
  const b = new LcmStore(f.path);
  const runA = a.openRun();
  assert.equal(a.forRun(runA.token).insertSummary(leaf()).created, true);

  const runB = b.openRun();
  assert.equal(runB.dropped, 0, "a run this process wrote is not a dead run");
  const collision = b.forRun(runB.token).insertSummary(leaf({ text: "b's attempt" }));
  assert.equal(collision.created, false);
  assert.equal(collision.foreignLive, true);
  b.abandonRun(runB.token);

  assert.deepEqual(a.commitRun(runA.token), { committed: 1, dropped: 0 });
  assert.equal(a.stats().summaries, 1, "the run that wrote the row still commits it");
  a.close();
  b.close();
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("an import waits for another process's pass, so no committed node names a pending row", async () => {
  const f = fixture();
  const holder = await holdRun(f.path, { first: "e0", last: "e1" });
  try {
    const rows: ExportRow[] = [
      {
        rowType: "message",
        v: EXPORT_VERSION,
        entryId: "e0",
        role: "user",
        text: "first message",
        tokens: 2,
        timestamp: 0,
      },
      {
        rowType: "message",
        v: EXPORT_VERSION,
        entryId: "e1",
        role: "assistant",
        text: "second message",
        tokens: 2,
        timestamp: 1,
      },
      {
        rowType: "summary",
        v: EXPORT_VERSION,
        ordinal: 0,
        kind: "leaf",
        text: "leaf over e0..e1",
        tokens: 4,
        depth: 0,
        firstEntryId: "e0",
        lastEntryId: "e1",
        messageEntryIds: ["e0", "e1"],
        childOrdinals: [],
      },
      {
        rowType: "summary",
        v: EXPORT_VERSION,
        ordinal: 1,
        kind: "condensed",
        text: "parent over the leaf",
        tokens: 3,
        depth: 1,
        firstEntryId: "e0",
        lastEntryId: "e1",
        messageEntryIds: [],
        childOrdinals: [0],
      },
    ];

    const refused = importTranscript(f.store, rows);
    assert.match(
      String(refused.refused),
      /in flight/,
      "this handle's own run list says nothing about the other process's pass",
    );
    assert.equal(f.store.stats().summaries, 0, "the refusal wrote nothing");

    await holder.stop();
    const next = new LcmStore(f.path);
    const reap = next.openRun();
    assert.equal(reap.dropped, 1, "the run whose process exited is reaped");
    next.abandonRun(reap.token);

    const after = importTranscript(next, rows);
    assert.equal(after.refused, undefined, "with the pass gone the import lands");
    assert.equal(after.summariesInserted, 2);
    assert.equal(
      checkIntegrity(next).findings.filter((x) => x.kind === "orphan-child").length,
      0,
      "the parent names the row this import wrote, so nothing dangles when a run is reaped",
    );
    next.close();
  } finally {
    await holder.stop();
  }
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("two handles in the same millisecond mint two tokens", () => {
  const f = fixture();
  // A store commits before it mints, so two calls normally straddle a millisecond
  // whether or not the token depends on the handle. Freezing the clock is what
  // makes this test fail when the token is only unique inside a handle.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000_000);
    const a = new LcmStore(f.path);
    const b = new LcmStore(f.path);
    assert.notEqual(
      a.openRun().token,
      b.openRun().token,
      "a token names a run in the store, so it cannot depend on the handle alone",
    );
    a.close();
    b.close();
  } finally {
    vi.useRealTimers();
  }
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a store written before runs were recorded migrates without its pending rows", () => {
  const f = fixture();
  leaveCrashedRun(f.path, { first: "e0", last: "e1" });
  const raw = new DatabaseSync(f.path);
  raw.exec("DELETE FROM runs");
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const migrated = new LcmStore(f.path);
  const rows = new DatabaseSync(f.path);
  assert.equal(
    (
      rows.prepare("SELECT COUNT(*) AS n FROM summaries WHERE status = 'pending'").get() as {
        n: number;
      }
    ).n,
    0,
    "the migration drops the row rather than leaving it for the run view to find",
  );
  rows.close();
  assert.equal(migrated.stats().summaries, 0, "a predated pending row does not survive the open");
  assert.equal(migrated.uncoveredMessagesInSpan("e0", "e1").length, 2);
  assert.equal(migrated.openRun().dropped, 0);
  migrated.close();
  f.store.close();
  const after = new DatabaseSync(f.path);
  assert.equal(
    (after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
  );
  after.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a run table that predates its present shape is replaced, and its rows reaped", () => {
  const f = fixture();
  leaveCrashedRun(f.path, { first: "e0", last: "e1" });
  const raw = new DatabaseSync(f.path);
  const token = (raw.prepare("SELECT token FROM runs").get() as { token: string }).token;
  raw.exec("DROP TABLE runs");
  raw.exec(
    "CREATE TABLE runs (token TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, session TEXT, started_at INTEGER NOT NULL)",
  );
  raw
    .prepare("INSERT INTO runs (token, owner, pid, session, started_at) VALUES (?, ?, ?, ?, ?)")
    .run(token, "old-handle", process.pid, "old-session", Date.now());
  raw.close();

  const migrated = new LcmStore(f.path);
  assert.equal(migrated.openRun().dropped, 1, "the replaced run's pending row is reaped");
  assert.equal(migrated.stats().summaries, 0);
  migrated.close();
  f.store.close();
  const after = new DatabaseSync(f.path);
  const columns = after.prepare("SELECT name FROM pragma_table_info('runs')").all() as Array<{
    name: string;
  }>;
  assert.deepEqual(
    columns.map((c) => c.name).sort(),
    ["pid", "session", "started_at", "token"],
    "the table holds the shape the statements name",
  );
  after.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("an import is refused while a run holds the store, and allowed after it closes", () => {
  const f = fixture();
  const s = f.store;
  const run = s.openRun();
  const refused = importTranscript(s, []);
  assert.match(String(refused.refused), /in flight/, "a committed write waits for the pass");

  s.abandonRun(run.token);
  const after = importTranscript(s, []);
  assert.doesNotMatch(String(after.refused ?? ""), /in flight/);
  s.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a run does not count another live run's pending span as its own", () => {
  const f = fixture();
  const s = f.store;
  const a = s.openRun();
  const b = s.openRun();
  const first = s.forRun(a.token).insertSummary(leaf());
  const second = s.forRun(b.token).insertSummary(leaf({ text: "b's attempt at the same span" }));
  assert.equal(second.created, false);
  assert.equal(second.own, false, "B must not treat A's unfinished row as its own");
  assert.equal(second.id, first.id);
  assert.equal(second.existingText, "leaf over e0..e1", "the winner's text travels with it");
  assert.equal(second.foreignLive, true, "B's view cannot read A's pending row");

  const repeat = s.forRun(a.token).insertSummary(leaf({ text: "a's second attempt" }));
  assert.equal(repeat.created, false);
  assert.equal(repeat.own, true, "a run's own pending row is its own");
  assert.equal(repeat.foreignLive, false, "a run's own row is in its view");

  assert.equal(s.abandonRun(b.token), 0, "B wrote no row to abandon");
  assert.deepEqual(s.commitRun(a.token), { committed: 1, dropped: 0 });
  assert.equal(s.stats().summaries, 1, "the run that wrote the row still commits it");
  s.close();
  rmSync(f.dir, { recursive: true, force: true });
});
