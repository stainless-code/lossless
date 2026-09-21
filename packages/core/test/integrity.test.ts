import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test } from "vite-plus/test";

import { ingestEntries } from "../src/ingest.ts";
import { checkIntegrity, repairIntegrity, type FindingKind } from "../src/integrity.ts";
import { LcmStore, SCHEMA_VERSION } from "../src/store.ts";
import { leaveCrashedRun } from "./support/run-holder.ts";

interface Fixture {
  path: string;
  store: LcmStore;
  /** A second connection, for the corruptions a healthy store makes impossible. */
  raw: () => DatabaseSync;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "lcm-integrity-"));
  const path = join(dir, "store.db");
  const store = new LcmStore(path);
  ingestEntries(store, [
    { entryId: "e0", role: "user", text: "first message", timestamp: 0 },
    { entryId: "e1", role: "assistant", text: "second message", timestamp: 1 },
  ]);
  store.insertSummary({
    kind: "leaf",
    text: "leaf",
    tokens: 1,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    messageIds: store.messagesInSpan("e0", "e1").map((m) => m.id),
  });
  return { path, store, raw: () => new DatabaseSync(path) };
}

const kindsOf = (findings: Array<{ kind: FindingKind }>): FindingKind[] =>
  findings.map((f) => f.kind).sort();

function messagesOnly(): { dir: string; path: string; store: LcmStore } {
  const dir = mkdtempSync(join(tmpdir(), "lcm-integrity-"));
  const path = join(dir, "store.db");
  const store = new LcmStore(path);
  ingestEntries(store, [
    { entryId: "e0", role: "user", text: "first message", timestamp: 0 },
    { entryId: "e1", role: "assistant", text: "second message", timestamp: 1 },
  ]);
  return { dir, path, store };
}

test("integrity: a healthy store reports nine checks and no violation", () => {
  const { store } = fixture();
  const report = checkIntegrity(store);
  assert.equal(
    report.checks,
    9,
    "one per FindingKind; the check table is exhaustive at compile time",
  );
  assert.deepEqual(report.findings, [], "a leaf covers every message");
  store.close();
});

test("integrity: an uncovered message is reported as info, not as a violation", () => {
  const s = new LcmStore(":memory:");
  ingestEntries(s, [{ entryId: "e0", role: "user", text: "not summarized yet", timestamp: 0 }]);
  const report = checkIntegrity(s);
  assert.deepEqual(kindsOf(report.findings), ["coverage"]);
  assert.equal(report.findings[0]!.severity, "info");
  assert.equal(report.findings[0]!.count, 1);
  assert.equal(report.findings[0]!.detail, "1 of 1 message(s) have no leaf yet");
  s.close();
});

test("integrity: every corruption the store can hold is named by its own check", () => {
  const f = fixture();
  const raw = f.raw();
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','ghost',1,0,'nope','nope',0)",
  );
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','reversed',1,0,'e1','e0',0)",
  );
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','deep',1,3,'e0','e0',0)",
  );
  raw.exec("DROP INDEX idx_summaries_span");
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','dup',1,0,'e0','e1',0)",
  );
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','dup',1,0,'e0','e1',0)",
  );
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("INSERT INTO message_files (message_id, file_id) VALUES (1, 'missing')");
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const report = checkIntegrity(f.store);
  assert.deepEqual(kindsOf(report.findings), [
    "duplicate-span",
    "foreign-key",
    "schema-version",
    "summary-shape",
    "summary-span",
  ]);
  const by = new Map(report.findings.map((x) => [x.kind, x]));
  assert.equal(by.get("summary-span")!.count, 1);
  assert.deepEqual(by.get("summary-span")!.sample, ["#2"]);
  assert.equal(by.get("summary-shape")!.count, 5);
  assert.equal(
    by.get("summary-shape")!.detail,
    "5 with a depth or provenance the DAG cannot walk; 1 whose span ends before it starts",
  );
  assert.deepEqual(by.get("summary-shape")!.sample, ["#2", "#3", "#4", "#5", "#6"]);
  assert.equal(by.get("duplicate-span")!.count, 3, "three rows claim one span");
  assert.deepEqual(by.get("duplicate-span")!.sample, ["e0..e1 (leaf) x3"]);
  assert.equal(
    by.get("schema-version")!.detail,
    `recorded version 0, this build writes ${SCHEMA_VERSION}`,
  );
  assert.equal(by.get("foreign-key")!.count, 1);
  f.store.close();
});

test("integrity: a committed node whose child is gone is a violation, and repair drops it", () => {
  const f = fixture();
  const leaf = f.store.allSummaries()[0]!;
  const parent = f.store.insertSummary({
    kind: "condensed",
    text: "parent over the leaf",
    tokens: 1,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e1",
    childSummaryIds: [leaf.id],
  });
  assert.equal(parent.created, true);
  const raw = f.raw();
  raw.exec(`DELETE FROM summaries WHERE id = ${leaf.id}`);
  raw.close();

  const report = checkIntegrity(f.store);
  assert.deepEqual(kindsOf(report.findings), ["coverage", "orphan-child"]);
  const finding = report.findings.find((x) => x.kind === "orphan-child")!;
  assert.equal(finding.severity, "violation");
  assert.equal(finding.count, 1);
  assert.deepEqual(finding.sample, [`#${parent.id}`]);

  const notes = repairIntegrity(f.store);
  assert.ok(
    notes.some((n) => n.includes("whose child no longer resolves")),
    notes.join("; "),
  );
  assert.deepEqual(
    kindsOf(checkIntegrity(f.store).findings),
    ["coverage"],
    "what is left is a store whose messages are simply not summarized",
  );
  assert.equal(f.store.allSummaries().length, 0, "the node nothing can walk is gone");
  assert.equal(f.store.grep("first message").length, 1, "its messages stay");
  f.store.close();
});

test("integrity: a run whose owner is gone is reported and reaped", () => {
  const f = messagesOnly();
  leaveCrashedRun(f.path, { first: "e0", last: "e1" });
  assert.equal(f.store.stats().summaries, 0, "no reader can see the row it left");

  const report = checkIntegrity(f.store);
  const finding = report.findings.find((x) => x.kind === "dead-run");
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding.severity, "info", "invisible rows are a chore, not a broken invariant");
  assert.equal(finding.count, 1);
  assert.match(finding.detail, /session\(s\) holder/);
  assert.deepEqual(finding.sample, [`#${f.store.integritySnapshot().deadRuns[0]!.rows[0]}`]);

  const notes = repairIntegrity(f.store);
  assert.ok(
    notes.some((n) => n.includes("whose writer is gone")),
    notes.join("; "),
  );
  assert.equal(f.store.integritySnapshot().deadRuns.length, 0);
  assert.deepEqual(
    kindsOf(checkIntegrity(f.store).findings),
    ["coverage"],
    "the pending row is gone, and the messages are simply not summarized yet",
  );
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("integrity: a run that still holds its rows is not a finding", () => {
  const f = messagesOnly();
  const run = f.store.openRun();
  f.store.forRun(run.token).insertSummary({
    kind: "leaf",
    text: "in flight",
    tokens: 1,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
  });
  assert.deepEqual(
    kindsOf(checkIntegrity(f.store).findings),
    ["coverage"],
    "a pass in flight holds its rows with no finding",
  );
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("integrity: a drifted index is not reported, and a rebuild is what removes it", () => {
  const f = fixture();
  const raw = f.raw();
  raw.exec("INSERT INTO messages_fts(rowid, text, entry_id) VALUES (99, 'ghosttoken', 'ghost')");
  const matches = (db: DatabaseSync) =>
    db
      .prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'ghosttoken'")
      .get() as {
      c: number;
    };
  assert.equal(matches(raw).c, 1, "the index holds the orphan row");
  raw.close();
  assert.equal(f.store.grep("ghosttoken").length, 0);
  assert.deepEqual(checkIntegrity(f.store).findings, [], "and it is not reported");
  f.store.rebuildFts();
  const after = f.raw();
  assert.equal(matches(after).c, 0, "the rebuild drops the orphan row");
  after.close();
  assert.equal(f.store.grep("second").length, 1, "and re-indexes the real rows");
  f.store.close();
});

test("integrity: a dropped index table is a finding, not an exception", () => {
  const f = fixture();
  const raw = f.raw();
  raw.exec("DROP TABLE messages_fts");
  raw.close();
  const report = checkIntegrity(f.store);
  const fts = report.findings.find((x) => x.kind === "fts-index");
  assert.ok(fts, JSON.stringify(report.findings));
  assert.equal(
    fts.detail,
    "the full-text index failed its own integrity check or could not be read",
  );
  assert.equal(report.findings.length, 1);
  f.store.close();
});

test("integrity: repair restores the index and drops the rows nothing can reach", () => {
  const f = fixture();
  const raw = f.raw();
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','ghost',1,0,'nope','nope',0)",
  );
  raw.exec("DROP INDEX idx_summaries_span");
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','dup',1,0,'e0','e1',0)",
  );
  raw.close();

  const notes = repairIntegrity(f.store);
  assert.deepEqual(notes, [
    "rebuilt the full-text index (2 row(s) from messages)",
    "dropped 1 summar(y|ies) with an unresolvable span",
    "dropped 1 duplicate span row(s)",
  ]);
  const after = checkIntegrity(f.store);
  assert.deepEqual(after.findings, [], "the repaired store is clean");
  assert.equal(f.store.grep("second").length, 1);
  assert.equal(f.store.allSummaries().length, 1, "one real span survives");
  f.store.close();
});

test("integrity: repair leaves a reversed span alone, because the fix needs the session file", () => {
  const f = fixture();
  const raw = f.raw();
  raw.exec(
    "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at) VALUES ('leaf','reversed',1,0,'e1','e0',0)",
  );
  raw.close();
  repairIntegrity(f.store);
  const after = checkIntegrity(f.store);
  assert.deepEqual(kindsOf(after.findings), ["summary-shape"]);
  assert.equal(f.store.allSummaries().length, 2, "the row is retained and reported");
  f.store.close();
});
