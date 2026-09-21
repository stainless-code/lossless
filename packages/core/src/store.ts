import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { estimateTokens } from "./estimate-tokens.ts";
import { isFileKind, type FileDescriptor } from "./files.ts";

export type LcmRole = "user" | "assistant" | "toolResult" | "custom";

/** Any role string Pi may emit (custom, branchSummary, bashExecution...) folds to the four stored roles. */
export function normalizeRole(r: string): LcmRole {
  if (r === "user" || r === "assistant" || r === "toolResult") return r;
  return "custom";
}

export interface StoredMessage {
  id: number;
  entryId: string;
  role: LcmRole;
  text: string;
  tokens: number;
  timestamp: number;
  /** JSON of the content blocks, present only when `text` is not a faithful
   * rendering of them (a thinking block, an image, a signature). Absent means
   * the derived text is the whole message. */
  payload?: string;
  /** Set when the entry has left the active branch. The bytes stay; search
   * excludes the row unless a caller asks for it. */
  removedAt?: number;
}

import type { ScannedRow } from "./pattern-scan.ts";

export interface GrepHit {
  entryId: string;
  role: LcmRole;
  text: string;
  /** The entry has left the active branch; its text is retained. */
  removed?: boolean;
  coveringSummaryId?: number;
}

export interface SummaryNode {
  id: number;
  kind: "leaf" | "condensed";
  text: string;
  tokens: number;
  depth: number;
  firstEntryId: string;
  lastEntryId: string;
  createdAt: number;
  /** A richer sibling text the ladder produced and did not store as primary,
   * so the projection can serve more detail when the budget has room. */
  thoroughText?: string;
  thoroughTokens?: number;
}

export interface IntegritySnapshot {
  ftsOk: boolean;
  messageRows: number;
  shapes: Array<{
    id: number;
    kind: "leaf" | "condensed";
    depth: number;
    messages: number;
    children: number;
  }>;
  spans: Array<{
    id: number;
    first: string;
    last: string;
    firstRowid: number | null;
    lastRowid: number | null;
  }>;
  duplicateSpans: Array<{ first: string; last: string; kind: string; count: number }>;
  orphanChildParents: number[];
  deadRuns: Array<{ session: string | null; rows: number[] }>;
  untrackedPending: number[];
  foreignKeyViolations: number;
  schemaVersion: number;
  uncoveredMessages: number;
}

/** A fresh row, or the row that already owns the span; `existingTokens` comes
 * from that row, so a caller reports the collision, not its intended write.
 * `own` says whether the run that asked may count this row as its own and replace
 * its text: a row it wrote, a committed row, or its own pending row. Another live
 * run's pending row is none of those. */
export type InsertSummaryResult =
  | { id: number; created: true; own: true }
  | {
      id: number;
      created: false;
      own: boolean;
      existingTokens: number;
      /** The colliding row's summary text. A caller whose view cannot read the row
       * still has to answer for the span it was given, and this is that span's
       * summary to reuse. */
      existingText: string;
      foreignLive: boolean;
    };

/** What a caller hands `insertSummary`. `run` stamps the row pending for that run;
 * without it the row is committed memory. */
export type InsertSummaryInput = {
  kind: "leaf" | "condensed";
  text: string;
  tokens: number;
  depth: number;
  firstEntryId: string;
  lastEntryId: string;
  messageIds?: number[];
  childSummaryIds?: number[];
  fileIds?: string[];
  thoroughText?: string;
  run?: string;
};

/** What a compaction pass needs from the store: the committed memory plus, when
 * the pass reads through `LcmStore.forRun`, the rows of its own run. `LcmStore`
 * satisfies this with the committed-only meaning. */
export interface PassStore extends IngestStore {
  /** The branch range a set of entry ids occupies: the oldest and the newest row
   * the store holds among them, or null when it holds none. Pi's context array
   * is not branch order (it hoists the newest compaction entry to the front),
   * while a span is a row range, so the store, whose rows are appended in
   * branch order, is what decides which end comes first. */
  spanBounds(entryIds: readonly string[]): { firstEntryId: string; lastEntryId: string } | null;
  uncoveredMessagesInSpan(firstEntryId: string, lastEntryId: string): StoredMessage[];
  filesForMessages(ids: readonly number[]): Array<FileDescriptor & { messageId: number }>;
  frontier(firstEntryId: string, lastEntryId: string): SummaryNode[];
  getSummary(id: number): SummaryNode | undefined;
  parentSummaryIds(summaryId: number): number[];
  fileIdsForSummaries(ids: readonly number[]): string[];
  insertSummary(s: InsertSummaryInput): InsertSummaryResult;
  updateSummaryText(id: number, text: string, tokens: number): void;
  setThoroughText(id: number, thoroughText: string): void;
}

export interface IngestStore {
  hasEntry(entryId: string): boolean;
  insertMessage(m: {
    entryId: string;
    role: LcmRole;
    text: string;
    tokens: number;
    timestamp: number;
    payload?: string;
  }): number;
  insertFile(d: FileDescriptor, firstEntryId: string): void;
  linkMessageFile(messageId: number, fileId: string): void;
}

/** Characters of a message the full-text index covers. Storage is verbatim, so
 * this bounds the index and not the row. */
export const FTS_PREFIX_CHARS = 100_000;

/** First published schema: pre-publish development stores were wiped, so every
 * store in the wild starts here and later generations count from this one. */
export const SCHEMA_VERSION = 1;

/** A store left behind by an older build. A read-only open refuses it rather than
 * migrating it: a search must not rewrite a file it is only reading, and a store
 * that cannot answer this build's statements has to be a reported skip. */
export class StaleStoreError extends Error {
  readonly generation: number;
  constructor(generation: number) {
    super(`store generation ${generation} is older than ${SCHEMA_VERSION}`);
    this.name = "StaleStoreError";
    this.generation = generation;
  }
}

/** The `runs` table on its own, because a run record is transient: when the shape
 * a store holds is not this one, the migration replaces the table rather than
 * trying to read rows the statements cannot name. */
const RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS runs (
  token      TEXT PRIMARY KEY NOT NULL,
  pid        INTEGER NOT NULL,
  session    TEXT,
  started_at INTEGER NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  timestamp  INTEGER NOT NULL,
  payload    TEXT,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_entry ON messages(entry_id);
CREATE TABLE IF NOT EXISTS summaries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('leaf','condensed')),
  text           TEXT NOT NULL,
  tokens         INTEGER NOT NULL,
  depth          INTEGER NOT NULL,
  first_entry_id TEXT NOT NULL,
  last_entry_id  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  thorough_text       TEXT,
  thorough_tokens     INTEGER,
  status         TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('pending','committed')),
  run            TEXT
);
${RUNS_TABLE}
CREATE TABLE IF NOT EXISTS files (
  file_id        TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  kind           TEXT NOT NULL,
  preview        TEXT NOT NULL,
  first_entry_id TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_files (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, file_id)
);
CREATE TABLE IF NOT EXISTS summary_files (
  summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, file_id)
);
CREATE TABLE IF NOT EXISTS provenance (
  summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  child_type TEXT NOT NULL CHECK (child_type IN ('message','summary')),
  child_id   INTEGER NOT NULL,
  PRIMARY KEY (summary_id, child_type, child_id)
);
CREATE TABLE IF NOT EXISTS model_state (
  model_key       TEXT PRIMARY KEY,
  chars_per_token REAL,
  samples         INTEGER NOT NULL DEFAULT 0,
  context_window  INTEGER,
  window_source   TEXT,
  updated_at      INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, entry_id UNINDEXED, content='messages', content_rowid='id'
);
-- The index covers a prefix of the text on purpose: the row keeps all of
-- it, and an FTS5 external-content delete must describe the row that was
-- inserted, so both triggers use the same expression. Old rows were stored
-- pre-sliced below the prefix, so substr is the identity for them.
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, entry_id)
    VALUES (new.id, substr(new.text, 1, ${FTS_PREFIX_CHARS}), new.entry_id);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, entry_id)
    VALUES ('delete', old.id, substr(old.text, 1, ${FTS_PREFIX_CHARS}), old.entry_id);
END;
`;

/** One migration step per schema generation. Each step inspects the schema
 * before it writes, so running the set on an already-migrated store is a no-op
 * and a store written before any version was recorded still upgrades. */
function migrate(db: DatabaseSync): void {
  addColumnIfMissing(db, "messages", "payload", "payload TEXT");
  addColumnIfMissing(db, "messages", "removed_at", "removed_at INTEGER");
  addColumnIfMissing(db, "summaries", "thorough_text", "thorough_text TEXT");
  addColumnIfMissing(db, "summaries", "thorough_tokens", "thorough_tokens INTEGER");
  addColumnIfMissing(
    db,
    "summaries",
    "status",
    "status TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('pending','committed'))",
  );
  addColumnIfMissing(db, "summaries", "run", "run TEXT");
  addColumnIfMissing(db, "model_state", "context_window", "context_window INTEGER");
  addColumnIfMissing(db, "model_state", "window_source", "window_source TEXT");
  // Only a store from before versions were recorded can hold a pending row from
  // before crash recovery existed: it is dropped rather than recovered.
  if (readVersion(db) < 1) db.exec("DELETE FROM summaries WHERE status = 'pending'");
  if (tableColumns(db, "runs").has("owner")) {
    db.exec("DROP TABLE runs");
    db.exec(RUNS_TABLE);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** The recorded schema generation, or 0 for a store written before one was. */
function readVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): boolean {
  if (tableColumns(db, table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

function createSpanIndex(db: DatabaseSync): void {
  db.exec(CREATE_SPAN_INDEX);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a process with this pid exists. `kill(pid, 0)` sends no signal and
 * answers only that: `EPERM` means the process is there and is not ours. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let idSeq = 0;
function uniqueId(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;
}

/** What a store knows about a model rather than about a session: the token ratio
 * measured for it against Pi's reported usage, and the context window a provider
 * stated when it refused an over-window request. A null ratio is a measurement that
 * disagree with itself, which is a state the estimator reads as "keep the
 * constant" and the report names. A null window is a model no provider has
 * corrected, which leaves Pi's belief in place. */
export interface ModelState {
  charsPerToken: number | null;
  samples: number;
  contextWindow: number | null;
  windowSource: string | null;
}

export const WINDOW_SOURCE_PROVIDER = "provider-error";

export class LcmStore {
  private db: DatabaseSync;
  private dbPath: string;
  /** Opened for reading a past session's store: no migration ran, so `generation`
   * is the file's own and a caller may have to skip it. */
  private readOnly = false;
  /** The schema generation this file carries, which read-only opens do not
   * change. A writer holds `SCHEMA_VERSION` by the time its constructor returns. */
  readonly generation: number;
  /** True while a `transaction` callback is running, so a reentrant call joins
   * the open transaction instead of nesting one, which SQLite rejects. */
  private inTransaction = false;
  /** Tokens of the runs this handle has open. Two runs can overlap inside one
   * handle, because the blocking path stops waiting for the async pass, so a
   * token names a run and not the handle. Whether a run this handle does not
   * hold is still running is read from the `runs` table, never from here. */
  private liveTokens = new Set<string>();
  private reapedInRun = new Map<string, number>();
  private stmts: {
    hasEntry: StatementSync;
    insertMessage: StatementSync;
    insertedId: StatementSync;
    insertSummary: StatementSync;
    insertProvenance: StatementSync;
    insertFile: StatementSync;
    linkMessageFile: StatementSync;
    linkSummaryFile: StatementSync;
    allFiles: StatementSync;
    countFiles: StatementSync;
    sumFileBytes: StatementSync;
    summaryShapes: StatementSync;
    summarySpans: StatementSync;
    duplicateSpans: StatementSync;
    uncoveredMessages: StatementSync;
    grep: StatementSync;
    grepCount: StatementSync;
    messagesInSpan: StatementSync;
    messagePage: StatementSync;
    uncoveredInSpan: StatementSync;
    spanBounds: StatementSync;
    frontier: StatementSync;
    allMessages: StatementSync;
    allSummaries: StatementSync;
    getSummary: StatementSync;
    summarySpanId: StatementSync;
    updateSummaryText: StatementSync;
    deleteSummary: StatementSync;
    setSummaryThorough: StatementSync;
    coveredMessageIds: StatementSync;
    coveringLeafOf: StatementSync;
    coveringSummaryByEntry: StatementSync;
    messageByEntry: StatementSync;
    countRemoved: StatementSync;
    parentSummaryIds: StatementSync;
    childSummaryIds: StatementSync;
    countMessages: StatementSync;
    countSummaries: StatementSync;
    pageBytes: StatementSync;
    entrySpan: StatementSync;
    coveredSize: StatementSync;
    payloadMessages: StatementSync;
    payloadBytes: StatementSync;
    commitRun: StatementSync;
    abandonRun: StatementSync;
    dropUnresolvable: StatementSync;
    insertRun: StatementSync;
    deleteRun: StatementSync;
    runOwner: StatementSync;
    openRuns: StatementSync;
    getModelState: StatementSync;
    setModelState: StatementSync;
    setModelWindow: StatementSync;
    deletePendingForRun: StatementSync;
    deleteUntrackedPending: StatementSync;
    orphanChildParents: StatementSync;
    pendingIdsForRun: StatementSync;
    untrackedPendingIds: StatementSync;
    dropOrphanChildren: StatementSync;
  };

  constructor(dbPath: string, opts?: { readOnly?: boolean; queryOnly?: boolean }) {
    // Two ways to read a store. SQLite refuses a strict read-only open of a WAL
    // database whose shared memory file is gone, which is what a clean exit
    // leaves, so the fallback opens normally and bans writes with `query_only`.
    this.readOnly = opts?.readOnly === true || opts?.queryOnly === true;
    if (!this.readOnly) mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, opts?.readOnly === true ? { readOnly: true } : {});
    if (opts?.queryOnly === true) this.db.exec("PRAGMA query_only = ON;");
    if (this.readOnly && readVersion(this.db) < SCHEMA_VERSION) {
      const generation = readVersion(this.db);
      this.db.close();
      throw new StaleStoreError(generation);
    }
    if (!this.readOnly) {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      // A write behind another connection waits rather than failing at once.
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA);
      migrate(this.db);
      // A store whose rows cannot satisfy the span index opens without it
      // rather than losing rows: `/lcm doctor` names the duplicates and
      // `--repair` applies the index after dropping the losers.
      try {
        createSpanIndex(this.db);
      } catch {}
    }
    this.generation = readVersion(this.db);
    const prep = (sql: string): StatementSync => this.db.prepare(sql);
    this.stmts = {
      hasEntry: prep("SELECT 1 FROM messages WHERE entry_id = ? LIMIT 1"),
      getModelState: prep(
        "SELECT chars_per_token, samples, context_window, window_source FROM model_state WHERE model_key = ?",
      ),
      setModelState: prep(
        `INSERT INTO model_state (model_key, chars_per_token, samples, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(model_key) DO UPDATE SET
				   chars_per_token = excluded.chars_per_token,
				   samples = excluded.samples,
				   updated_at = excluded.updated_at`,
      ),
      setModelWindow: prep(
        `INSERT INTO model_state (model_key, context_window, window_source, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(model_key) DO UPDATE SET
				   context_window = excluded.context_window,
				   window_source = excluded.window_source,
				   updated_at = excluded.updated_at`,
      ),
      insertMessage: prep(
        "INSERT OR IGNORE INTO messages (entry_id, role, text, tokens, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)",
      ),
      insertedId: prep("SELECT id FROM messages WHERE entry_id = ?"),
      insertSummary: prep(
        "INSERT INTO summaries (kind, text, tokens, depth, first_entry_id, last_entry_id, created_at, thorough_text, thorough_tokens, status, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      insertProvenance: prep(
        "INSERT OR IGNORE INTO provenance (summary_id, child_type, child_id) VALUES (?, ?, ?)",
      ),
      commitRun: prep(
        "UPDATE summaries SET status = 'committed', run = NULL WHERE run = ? AND status = 'pending'",
      ),
      abandonRun: prep("DELETE FROM summaries WHERE run = ? AND status = 'pending'"),
      insertRun: prep("INSERT INTO runs (token, pid, session, started_at) VALUES (?, ?, ?, ?)"),
      deleteRun: prep("DELETE FROM runs WHERE token = ?"),
      runOwner: prep("SELECT pid FROM runs WHERE token = ?"),
      openRuns: prep("SELECT token, session FROM runs"),
      deletePendingForRun: prep("DELETE FROM summaries WHERE status = 'pending' AND run = ?"),
      deleteUntrackedPending: prep(
        "DELETE FROM summaries WHERE status = 'pending' AND (run IS NULL OR run NOT IN (SELECT token FROM runs))",
      ),
      orphanChildParents: prep(
        `SELECT DISTINCT p.summary_id AS id FROM provenance p JOIN summaries s ON s.id = p.summary_id
          WHERE s.status = 'committed' AND p.child_type = 'summary'
            AND NOT EXISTS (SELECT 1 FROM summaries c WHERE c.id = p.child_id)
          ORDER BY p.summary_id`,
      ),
      pendingIdsForRun: prep(
        "SELECT id FROM summaries WHERE status = 'pending' AND run = ? ORDER BY id",
      ),
      untrackedPendingIds: prep(
        "SELECT id FROM summaries WHERE status = 'pending' AND (run IS NULL OR run NOT IN (SELECT token FROM runs)) ORDER BY id",
      ),
      dropOrphanChildren: prep(
        `DELETE FROM summaries WHERE status = 'committed' AND id IN (
           SELECT p.summary_id FROM provenance p WHERE p.child_type = 'summary'
             AND NOT EXISTS (SELECT 1 FROM summaries c WHERE c.id = p.child_id))`,
      ),
      dropUnresolvable: prep(
        `DELETE FROM summaries WHERE run = ? AND status = 'pending' AND id IN (
           SELECT p.summary_id FROM provenance p WHERE p.child_type = 'summary'
             AND NOT EXISTS (SELECT 1 FROM summaries c WHERE c.id = p.child_id))`,
      ),
      insertFile: prep(
        "INSERT OR IGNORE INTO files (file_id, path, bytes, sha256, kind, preview, first_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      linkMessageFile: prep(
        "INSERT OR IGNORE INTO message_files (message_id, file_id) VALUES (?, ?)",
      ),
      linkSummaryFile: prep(
        "INSERT OR IGNORE INTO summary_files (summary_id, file_id) VALUES (?, ?)",
      ),
      allFiles: prep(
        `SELECT f.file_id, f.path, f.bytes, f.sha256, f.kind, f.preview,
                (SELECT group_concat(m.entry_id, char(31))
                   FROM message_files mf JOIN messages m ON m.id = mf.message_id
                  WHERE mf.file_id = f.file_id) AS entry_ids
           FROM files f ORDER BY f.created_at ASC, f.file_id ASC`,
      ),
      countFiles: prep("SELECT COUNT(*) c FROM files"),
      sumFileBytes: prep("SELECT COALESCE(SUM(bytes), 0) b FROM files"),
      summaryShapes: prep(
        `SELECT s.id, s.kind, s.depth,
                (SELECT COUNT(*) FROM provenance p
                  WHERE p.summary_id = s.id AND p.child_type = 'message') AS messages,
                (SELECT COUNT(*) FROM provenance p
                  WHERE p.summary_id = s.id AND p.child_type = 'summary') AS children
           FROM summaries s WHERE (s.status = 'committed' OR s.run = ?) ORDER BY s.id ASC`,
      ),
      summarySpans: prep(
        `SELECT s.id, s.first_entry_id, s.last_entry_id,
                (SELECT rowid FROM messages WHERE entry_id = s.first_entry_id) AS first_rowid,
                (SELECT rowid FROM messages WHERE entry_id = s.last_entry_id) AS last_rowid
           FROM summaries s WHERE (s.status = 'committed' OR s.run = ?) ORDER BY s.id ASC`,
      ),
      duplicateSpans: prep(
        `SELECT first_entry_id, last_entry_id, kind, COUNT(*) c FROM summaries s
          WHERE (s.status = 'committed' OR s.run = ?)
          GROUP BY first_entry_id, last_entry_id, kind HAVING c > 1 ORDER BY first_entry_id ASC`,
      ),
      uncoveredMessages: prep(
        `SELECT COUNT(*) c FROM messages m WHERE NOT EXISTS (
             SELECT 1 FROM provenance p JOIN summaries s ON s.id = p.summary_id
              WHERE p.child_type = 'message' AND p.child_id = m.id
                AND (s.status = 'committed' OR s.run = ?))`,
      ),
      grepCount: prep(
        `SELECT COUNT(*) c
           FROM messages_fts f JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
            AND (? = 1 OR m.removed_at IS NULL)`,
      ),
      grep: prep(
        `SELECT m.id, m.entry_id, m.role, m.text, m.removed_at
           FROM messages_fts f JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
            AND (? = 1 OR m.removed_at IS NULL)
          ORDER BY rank LIMIT ?`,
      ),
      messagesInSpan: prep(
        `SELECT id, entry_id, role, text, tokens, timestamp FROM messages
         WHERE rowid BETWEEN (SELECT rowid FROM messages WHERE entry_id = ?)
                       AND (SELECT rowid FROM messages WHERE entry_id = ?)
         ORDER BY rowid ASC`,
      ),
      messagePage: prep(
        `SELECT id, entry_id, role, text, removed_at FROM messages
         WHERE rowid > ? AND (? = 1 OR removed_at IS NULL)
         ORDER BY rowid ASC LIMIT ?`,
      ),
      spanBounds: prep(
        `WITH ids(value) AS (SELECT value FROM json_each(?)),
              span(lo, hi) AS (SELECT min(m.rowid), max(m.rowid) FROM messages m
                                WHERE m.entry_id IN (SELECT value FROM ids))
         SELECT (SELECT entry_id FROM messages WHERE rowid = span.lo) AS first,
                (SELECT entry_id FROM messages WHERE rowid = span.hi) AS last
           FROM span`,
      ),
      uncoveredInSpan: prep(
        `SELECT id, entry_id, role, text, tokens, timestamp FROM messages m
         WHERE m.rowid BETWEEN (SELECT rowid FROM messages WHERE entry_id = ?)
                         AND (SELECT rowid FROM messages WHERE entry_id = ?)
           AND NOT EXISTS (SELECT 1 FROM provenance p JOIN summaries s ON s.id = p.summary_id
                            WHERE p.child_type = 'message' AND p.child_id = m.id
                              AND (s.status = 'committed' OR s.run = ?))
         ORDER BY m.rowid ASC`,
      ),
      frontier: prep(
        `SELECT s.id, s.kind, s.text, s.tokens, s.depth, s.first_entry_id, s.last_entry_id, s.created_at, s.thorough_text, s.thorough_tokens,
                (SELECT rowid FROM messages WHERE entry_id = s.first_entry_id) AS first_rowid,
                (SELECT rowid FROM messages WHERE entry_id = s.last_entry_id)  AS last_rowid
           FROM summaries s
          WHERE first_rowid >= (SELECT rowid FROM messages WHERE entry_id = ?)
            AND last_rowid  <= (SELECT rowid FROM messages WHERE entry_id = ?)
            AND (s.status = 'committed' OR s.run = ?)
            AND NOT EXISTS (SELECT 1 FROM provenance p JOIN summaries ps ON ps.id = p.summary_id
                             WHERE p.child_type = 'summary' AND p.child_id = s.id
                               AND (ps.status = 'committed' OR ps.run = ?))
          ORDER BY first_rowid ASC, last_rowid DESC, depth DESC, id DESC`,
      ),
      allMessages: prep(
        "SELECT id, entry_id, role, text, tokens, timestamp, payload, removed_at FROM messages ORDER BY rowid ASC",
      ),
      allSummaries: prep(
        "SELECT s.id, s.kind, s.text, s.tokens, s.depth, s.first_entry_id, s.last_entry_id, s.created_at, s.thorough_text, s.thorough_tokens FROM summaries s WHERE (s.status = 'committed' OR s.run = ?) ORDER BY s.id ASC",
      ),
      getSummary: prep(
        "SELECT s.id, s.kind, s.text, s.tokens, s.depth, s.first_entry_id, s.last_entry_id, s.created_at, s.thorough_text, s.thorough_tokens FROM summaries s WHERE s.id = ? AND (s.status = 'committed' OR s.run = ?)",
      ),
      summarySpanId: prep(
        "SELECT id, text, tokens, status, run FROM summaries WHERE first_entry_id = ? AND last_entry_id = ? AND kind = ?",
      ),
      updateSummaryText: prep("UPDATE summaries SET text = ?, tokens = ? WHERE id = ?"),
      deleteSummary: prep("DELETE FROM summaries WHERE id = ?"),
      setSummaryThorough: prep(
        "UPDATE summaries SET thorough_text = ?, thorough_tokens = ? WHERE id = ?",
      ),
      coveredMessageIds: prep("SELECT child_type, child_id FROM provenance WHERE summary_id = ?"),
      coveringLeafOf: prep(
        `SELECT p.summary_id AS id FROM provenance p JOIN summaries s ON s.id = p.summary_id
          WHERE p.child_type = 'message' AND p.child_id = ?
            AND (s.status = 'committed' OR s.run = ?)
          ORDER BY s.depth ASC, s.id DESC LIMIT 1`,
      ),
      coveringSummaryByEntry: prep(
        `SELECT p.summary_id AS id FROM provenance p
           JOIN summaries s ON s.id = p.summary_id
           JOIN messages m ON m.id = p.child_id
          WHERE p.child_type = 'message' AND m.entry_id = ?
            AND (s.status = 'committed' OR s.run = ?)
          ORDER BY s.depth ASC, s.id DESC LIMIT 1`,
      ),
      messageByEntry: prep(
        "SELECT id, entry_id, role, text, tokens, timestamp, payload, removed_at FROM messages WHERE entry_id = ?",
      ),
      countRemoved: prep("SELECT COUNT(*) c FROM messages WHERE removed_at IS NOT NULL"),
      parentSummaryIds: prep(
        "SELECT p.summary_id AS id FROM provenance p JOIN summaries s ON s.id = p.summary_id WHERE p.child_type = 'summary' AND p.child_id = ? AND (s.status = 'committed' OR s.run = ?) ORDER BY p.summary_id ASC",
      ),
      childSummaryIds: prep(
        "SELECT child_id AS id FROM provenance WHERE child_type = 'summary' AND summary_id = ? ORDER BY child_id ASC",
      ),
      countMessages: prep("SELECT COUNT(*) c FROM messages"),
      payloadMessages: prep("SELECT COUNT(*) c FROM messages WHERE payload IS NOT NULL"),
      payloadBytes: prep("SELECT COALESCE(SUM(length(payload)), 0) b FROM messages"),
      countSummaries: prep(
        "SELECT COUNT(*) c FROM summaries s WHERE (s.status = 'committed' OR s.run = ?)",
      ),
      pageBytes: prep(
        "SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS b",
      ),
      entrySpan: prep(
        `SELECT (SELECT entry_id FROM messages ORDER BY rowid ASC LIMIT 1) AS first,
                (SELECT entry_id FROM messages ORDER BY rowid DESC LIMIT 1) AS last`,
      ),
      coveredSize: prep(
        `WITH RECURSIVE cover(summary_id, child_type, child_id) AS (
             SELECT summary_id, child_type, child_id FROM provenance WHERE summary_id = ?
             UNION
             SELECT p.summary_id, p.child_type, p.child_id FROM provenance p
               JOIN cover c ON c.child_type = 'summary' AND c.child_id = p.summary_id)
           SELECT COALESCE(SUM(m.tokens), 0) AS tokens, COUNT(*) AS messages
             FROM cover c JOIN messages m ON c.child_type = 'message' AND m.id = c.child_id`,
      ),
    };
    try {
      chmodSync(dbPath, 0o600);
    } catch {}
  }

  /** Close the handle: no run of this handle survives it, and the connection is
   * released even when a run could not be abandoned, so a failure here cannot
   * leave a connection and a set of invisible rows behind. */
  close(): void {
    if (this.readOnly) {
      this.db.close();
      return;
    }
    try {
      for (const token of this.liveTokens) this.abandonRun(token);
    } finally {
      this.db.close();
    }
  }

  /** Open a run: rows written with its token are pending until `commitRun`, and
   * the row this writes is what lets another handle tell it from a run whose
   * writer is gone. Reaps what such a run left, which this handle cannot be. */
  openRun(opts: { session?: string } = {}): { token: string; dropped: number } {
    const dropped = this.liveTokens.size === 0 ? this.reapPending() : 0;
    const token = uniqueId();
    this.stmts.insertRun.run(token, process.pid, opts.session ?? null, Date.now());
    this.liveTokens.add(token);
    return { token, dropped };
  }

  /** True while any run is open whose writer is still there, this handle's or
   * another process's, which is what an import has to wait for. */
  hasLiveRun(): boolean {
    return (this.stmts.openRuns.all() as Array<{ token: string }>).some((r) =>
      this.isRunLive(r.token),
    );
  }

  /** Commit a run: drop its pending rows whose child no longer resolves, then flip
   * the rest. One transaction, so a reader never sees a half-committed run, and
   * idempotent for a token this handle no longer holds. */
  commitRun(token: string): { committed: number; dropped: number } {
    if (!this.liveTokens.has(token)) return { committed: 0, dropped: 0 };
    const closed = this.transaction(() => {
      let dropped = this.dropUnresolvable(token);
      dropped += this.reapedInRun.get(token) ?? 0;
      const committed = Number(this.stmts.commitRun.run(token).changes);
      this.stmts.deleteRun.run(token);
      return { committed, dropped };
    });
    this.liveTokens.delete(token);
    this.reapedInRun.delete(token);
    return closed;
  }

  /** Delete a run's pending rows and close it. Idempotent, so a `finally` can call
   * it after a commit has already closed the run. */
  abandonRun(token: string): number {
    if (!this.liveTokens.has(token)) return 0;
    const dropped = this.transaction(() => {
      const removed = Number(this.stmts.abandonRun.run(token).changes);
      const replaced = this.reapedInRun.get(token) ?? 0;
      this.stmts.deleteRun.run(token);
      return removed + replaced;
    });
    this.liveTokens.delete(token);
    this.reapedInRun.delete(token);
    return dropped;
  }

  /** A view of this store for one run: the committed memory plus that run's own
   * rows, which is what a pass must read to see its own writes. */
  forRun(token: string): PassStore {
    return new RunView(this, token);
  }

  /** True while the run that wrote a row is still going somewhere, as far as this
   * store can tell. A run this handle holds is live; a run written by this
   * process is live, because a pid cannot separate two handles in one process and
   * refusing to delete is the safe answer; a run written by another process is
   * live while its pid is. A row whose run has no record at all was written
   * without one, which no open path does, so nothing owns it. */
  private isRunLive(token: string): boolean {
    if (this.liveTokens.has(token)) return true;
    const row = this.stmts.runOwner.get(token) as { pid: number } | undefined;
    if (!row) return false;
    const pid = Number(row.pid);
    return pid === process.pid || processAlive(pid);
  }

  /** Delete what a run left behind whose writer is gone, and its record with it.
   * A live owner's rows are never touched, whatever handle asks, which is what
   * makes a second handle safe to open. No reader can see the rows this removes,
   * and each one holds the span it claims. */
  private reapPending(): number {
    return this.transaction(() => {
      let dropped = 0;
      for (const row of this.stmts.openRuns.all() as Array<{ token: string }>) {
        if (this.isRunLive(row.token)) continue;
        dropped += Number(this.stmts.deletePendingForRun.run(row.token).changes);
        this.stmts.deleteRun.run(row.token);
      }
      return dropped + Number(this.stmts.deleteUntrackedPending.run().changes);
    });
  }

  /** Delete this run's pending rows whose child no longer exists, deepest first: a
   * parent that loses a child must not leave a grandparent behind. A child can go
   * away between the frontier read that selected it and this commit. */
  private dropUnresolvable(token: string): number {
    let dropped = 0;
    for (;;) {
      const n = Number(this.stmts.dropUnresolvable.run(token).changes);
      dropped += n;
      if (n === 0) return dropped;
    }
  }

  hasEntry(entryId: string): boolean {
    return this.stmts.hasEntry.get(entryId) !== undefined;
  }

  insertMessage(m: {
    entryId: string;
    role: LcmRole;
    text: string;
    tokens: number;
    timestamp: number;
    payload?: string;
  }): number {
    this.stmts.insertMessage.run(
      m.entryId,
      m.role,
      m.text,
      m.tokens,
      m.timestamp,
      m.payload ?? null,
    );
    const row = this.stmts.insertedId.get(m.entryId) as { id: number } | undefined;
    return row?.id ?? -1;
  }

  /** One write transaction around a group of statements, so a compaction is
   * atomic: the node row, its provenance rows and its file links either all
   * land or none do. `node:sqlite` ships no transaction helper, so the
   * statements are explicit. A reentrant call joins the open transaction: the
   * caller that opened it owns the commit, so an inner throw rolls the whole
   * group back rather than leaving a half-applied write. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new Error(`lcm: rollback failed after ${reason(error)}: ${reason(rollbackError)}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  insertSummary(s: InsertSummaryInput): InsertSummaryResult {
    const status = s.run === undefined ? "committed" : "pending";
    return this.transaction(() => {
      let id: number;
      try {
        id = Number(
          this.stmts.insertSummary.run(
            s.kind,
            s.text,
            s.tokens,
            s.depth,
            s.firstEntryId,
            s.lastEntryId,
            Date.now(),
            s.thoroughText ?? null,
            s.thoroughText === undefined ? null : estimateTokens(s.thoroughText),
            status,
            s.run ?? null,
          ).lastInsertRowid,
        );
      } catch {
        const existing = this.stmts.summarySpanId.get(s.firstEntryId, s.lastEntryId, s.kind) as
          | { id: number; text: string; tokens: number; status: string; run: string | null }
          | undefined;
        if (!existing) throw new Error("lcm: insertSummary failed and no existing row found");
        if (existing.status === "pending" && !this.isRunLive(String(existing.run))) {
          this.stmts.deleteSummary.run(Number(existing.id));
          if (s.run !== undefined) {
            this.reapedInRun.set(s.run, (this.reapedInRun.get(s.run) ?? 0) + 1);
          }
          return this.insertSummary(s);
        }
        const own =
          existing.status === "committed" || (s.run !== undefined && existing.run === s.run);
        return {
          id: Number(existing.id),
          created: false,
          own,
          existingTokens: Number(existing.tokens),
          existingText: String(existing.text),
          foreignLive:
            !own && existing.status === "pending" && this.isRunLive(String(existing.run)),
        };
      }
      for (const mid of s.messageIds ?? []) this.stmts.insertProvenance.run(id, "message", mid);
      for (const sid of s.childSummaryIds ?? [])
        this.stmts.insertProvenance.run(id, "summary", sid);
      for (const fid of s.fileIds ?? []) this.stmts.linkSummaryFile.run(id, fid);
      return { id, created: true, own: true };
    });
  }

  insertFile(d: FileDescriptor, firstEntryId: string): void {
    this.stmts.insertFile.run(
      d.fileId,
      d.path,
      d.bytes,
      d.sha256,
      d.kind,
      d.preview,
      firstEntryId,
      Date.now(),
    );
  }

  linkMessageFile(messageId: number, fileId: string): void {
    this.stmts.linkMessageFile.run(messageId, fileId);
  }

  filesForMessages(ids: readonly number[]): Array<FileDescriptor & { messageId: number }> {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT f.file_id, f.path, f.bytes, f.sha256, f.kind, f.preview, mf.message_id AS message_id
           FROM message_files mf JOIN files f ON f.file_id = mf.file_id
          WHERE mf.message_id IN (${ids.map(() => "?").join(",")}) ORDER BY mf.message_id ASC`,
      )
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...rToFile(r), messageId: Number(r.message_id) }));
  }

  fileIdsForMessages(ids: readonly number[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT file_id FROM message_files WHERE message_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<{ file_id: string }>;
    return rows.map((r) => String(r.file_id));
  }

  fileIdsForSummaries(ids: readonly number[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT file_id FROM summary_files WHERE summary_id IN (${ids.map(() => "?").join(",")}) ORDER BY file_id ASC`,
      )
      .all(...ids) as Array<{ file_id: string }>;
    return rows.map((r) => String(r.file_id));
  }

  filesForSummaries(ids: readonly number[]): FileDescriptor[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.file_id, f.path, f.bytes, f.sha256, f.kind, f.preview
           FROM summary_files sf JOIN files f ON f.file_id = sf.file_id
          WHERE sf.summary_id IN (${ids.map(() => "?").join(",")}) ORDER BY f.path ASC`,
      )
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map(rToFile);
  }

  allFiles(): Array<FileDescriptor & { entryIds: string[] }> {
    const rows = this.stmts.allFiles.all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ...rToFile(r),
      entryIds:
        typeof r.entry_ids === "string" && r.entry_ids.length > 0
          ? r.entry_ids.split("\u001f")
          : [],
    }));
  }

  /** Replace a node's text in place: the span, provenance, and created_at stay. */
  updateSummaryText(id: number, text: string, tokens: number): void {
    this.stmts.updateSummaryText.run(text, tokens, id);
  }

  setThoroughText(id: number, thoroughText: string): void {
    this.stmts.setSummaryThorough.run(thoroughText, estimateTokens(thoroughText), id);
  }

  messagesInSpan(firstEntryId: string, lastEntryId: string): StoredMessage[] {
    const rows = this.stmts.messagesInSpan.all(firstEntryId, lastEntryId) as Array<
      Record<string, unknown>
    >;
    return rows.map(rToMessage);
  }

  spanBounds(entryIds: readonly string[]): { firstEntryId: string; lastEntryId: string } | null {
    const row = this.stmts.spanBounds.get(JSON.stringify(entryIds)) as
      | { first: string | null; last: string | null }
      | undefined;
    if (!row?.first || !row.last) return null;
    return { firstEntryId: row.first, lastEntryId: row.last };
  }

  uncoveredMessagesInSpan(
    firstEntryId: string,
    lastEntryId: string,
    run?: string,
  ): StoredMessage[] {
    const rows = this.stmts.uncoveredInSpan.all(firstEntryId, lastEntryId, run ?? null) as Array<
      Record<string, unknown>
    >;
    return rows.map(rToMessage);
  }

  /** Minimal top-level cover: no summary's child, oldest first, dropping any node
   * whose span sits inside the previous kept one, which is what keeps the cover
   * non-nested: condensation's group span must be one no row already holds. */
  frontier(firstEntryId: string, lastEntryId: string, run?: string): SummaryNode[] {
    const rows = this.stmts.frontier.all(
      firstEntryId,
      lastEntryId,
      run ?? null,
      run ?? null,
    ) as Array<Record<string, unknown>>;
    const out: SummaryNode[] = [];
    let coveredTo = -1;
    for (const r of rows) {
      if (Number(r.last_rowid) <= coveredTo) continue;
      out.push(rToSummary(r));
      coveredTo = Number(r.last_rowid);
    }
    return out;
  }

  grep(
    pattern: string,
    opts?: {
      limit?: number;
      offset?: number;
      withinMessageIds?: ReadonlySet<number>;
      includeRemoved?: boolean;
    },
  ): GrepHit[] {
    const limit = opts?.limit ?? 20;
    const offset = Math.max(0, opts?.offset ?? 0);
    const scope = opts?.withinMessageIds;
    const want = limit + offset;
    const rows = this.stmts.grep.all(
      pattern,
      opts?.includeRemoved === true ? 1 : 0,
      scope ? Math.max(want, scope.size + want) : want,
    ) as Array<{
      id: number;
      entry_id: string;
      role: string;
      text: string;
      removed_at: number | null;
    }>;
    const hits: GrepHit[] = [];
    let seen = 0;
    for (const r of rows) {
      if (scope && !scope.has(Number(r.id))) continue;
      if (seen < offset) {
        seen++;
        continue;
      }
      if (hits.length >= limit) break;
      seen++;
      const leaf = this.stmts.coveringLeafOf.get(r.id, null) as { id: number } | undefined;
      hits.push({
        entryId: r.entry_id,
        role: normalizeRole(r.role),
        text: r.text,
        ...(r.removed_at == null ? {} : { removed: true }),
        coveringSummaryId: leaf ? Number(leaf.id) : undefined,
      });
    }
    return hits;
  }

  grepCount(
    pattern: string,
    opts?: { withinMessageIds?: ReadonlySet<number>; includeRemoved?: boolean },
  ): number | undefined {
    const scope = opts?.withinMessageIds;
    if (scope) {
      return this.grep(pattern, {
        limit: scope.size,
        withinMessageIds: scope,
        includeRemoved: opts?.includeRemoved === true,
      }).length;
    }
    try {
      const row = this.stmts.grepCount.get(pattern, opts?.includeRemoved === true ? 1 : 0) as
        | { c: number }
        | undefined;
      if (!row) return undefined;
      return Number(row.c);
    } catch {
      return undefined;
    }
  }

  messagePage(
    afterRowId: number,
    limit: number,
    opts?: { withinMessageIds?: ReadonlySet<number>; includeRemoved?: boolean },
  ): ScannedRow[] {
    const scope = opts?.withinMessageIds;
    const want = scope ? Math.max(limit, scope.size + limit) : limit;
    const rows = this.stmts.messagePage.all(
      afterRowId,
      opts?.includeRemoved === true ? 1 : 0,
      want,
    ) as Array<{
      id: number;
      entry_id: string;
      role: string;
      text: string;
      removed_at: number | null;
    }>;
    const out: ScannedRow[] = [];
    for (const r of rows) {
      if (scope && !scope.has(Number(r.id))) continue;
      out.push({
        rowid: Number(r.id),
        entryId: r.entry_id,
        role: r.role,
        text: r.text,
        removed: r.removed_at != null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  coveringSummaryId(entryId: string): number | undefined {
    const row = this.stmts.coveringSummaryByEntry.get(entryId, null) as { id: number } | undefined;
    return row === undefined ? undefined : Number(row.id);
  }

  messageByEntryId(entryId: string): StoredMessage | undefined {
    const row = this.stmts.messageByEntry.get(entryId);
    return row ? rToMessage(row as Record<string, unknown>) : undefined;
  }

  parentSummaryIds(summaryId: number, run?: string): number[] {
    return (this.stmts.parentSummaryIds.all(summaryId, run ?? null) as Array<{ id: number }>).map(
      (r) => Number(r.id),
    );
  }

  childSummaryIds(summaryId: number): number[] {
    return (this.stmts.childSummaryIds.all(summaryId) as Array<{ id: number }>).map((r) =>
      Number(r.id),
    );
  }

  getSummary(id: number, run?: string): SummaryNode | undefined {
    const row = this.stmts.getSummary.get(id, run ?? null);
    return row ? rToSummary(row) : undefined;
  }

  /** Bounded by a visited set, so a corrupt cycle cannot recurse forever. */
  coveredMessageIds(summaryId: number, seen: Set<number> = new Set()): number[] {
    if (seen.has(summaryId)) return [];
    seen.add(summaryId);
    const rows = this.stmts.coveredMessageIds.all(summaryId) as Array<{
      child_type: string;
      child_id: number;
    }>;
    const out: number[] = [];
    for (const r of rows) {
      if (r.child_type === "message") out.push(r.child_id);
      else out.push(...this.coveredMessageIds(r.child_id, seen));
    }
    return out;
  }

  integritySnapshot(): IntegritySnapshot {
    let ftsOk = true;
    // Structural damage is the one signal an external-content FTS5 table
    // reports: counts and rowid scans read the content table instead.
    try {
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
    } catch {
      ftsOk = false;
    }
    const num = (v: unknown): number => Number(v);
    const nullable = (v: unknown): number | null => (v == null ? null : Number(v));
    const shapes = this.stmts.summaryShapes.all(null) as Array<Record<string, unknown>>;
    const spans = this.stmts.summarySpans.all(null) as Array<Record<string, unknown>>;
    const duplicates = this.stmts.duplicateSpans.all(null) as Array<Record<string, unknown>>;
    return {
      ftsOk,
      messageRows: this.messageCount(),
      shapes: shapes.map((r) => ({
        id: num(r.id),
        kind: r.kind === "condensed" ? "condensed" : "leaf",
        depth: num(r.depth),
        messages: num(r.messages),
        children: num(r.children),
      })),
      spans: spans.map((r) => ({
        id: num(r.id),
        first: String(r.first_entry_id),
        last: String(r.last_entry_id),
        firstRowid: nullable(r.first_rowid),
        lastRowid: nullable(r.last_rowid),
      })),
      duplicateSpans: duplicates.map((r) => ({
        first: String(r.first_entry_id),
        last: String(r.last_entry_id),
        kind: String(r.kind),
        count: num(r.c),
      })),
      orphanChildParents: (this.stmts.orphanChildParents.all() as Array<{ id: number }>).map((r) =>
        num(r.id),
      ),
      deadRuns: (
        this.stmts.openRuns.all() as Array<{
          token: string;
          session: string | null;
        }>
      )
        .filter((r) => !this.isRunLive(r.token))
        .map((r) => ({
          session: r.session,
          rows: (this.stmts.pendingIdsForRun.all(r.token) as Array<{ id: number }>).map((x) =>
            num(x.id),
          ),
        })),
      untrackedPending: (this.stmts.untrackedPendingIds.all() as Array<{ id: number }>).map((r) =>
        num(r.id),
      ),
      foreignKeyViolations: this.db.prepare("PRAGMA foreign_key_check").all().length,
      schemaVersion: readVersion(this.db),
      uncoveredMessages: num((this.stmts.uncoveredMessages.get(null) as { c: number }).c),
    };
  }

  /** Restore the full-text index. The schema is re-applied first, because a
   * dropped virtual table cannot be rebuilt, only recreated, and the DDL that
   * knows how is the schema itself. Everything in it is `IF NOT EXISTS` apart
   * from the two triggers, which are dropped and recreated on purpose. */
  rebuildFts(): void {
    this.db.exec(SCHEMA);
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }

  deleteOrphanSpans(): number {
    const result = this.db
      .prepare(
        `DELETE FROM summaries WHERE status = 'committed' AND (
           (SELECT COUNT(*) FROM messages WHERE entry_id = summaries.first_entry_id) = 0
        OR (SELECT COUNT(*) FROM messages WHERE entry_id = summaries.last_entry_id) = 0)`,
      )
      .run();
    return Number(result.changes);
  }

  deleteOrphanChildren(): number {
    let dropped = 0;
    for (;;) {
      const n = Number(this.stmts.dropOrphanChildren.run().changes);
      dropped += n;
      if (n === 0) return dropped;
    }
  }

  reapDeadRuns(): number {
    return this.reapPending();
  }

  /** When one span is claimed twice, the row that carries provenance wins over
   * one that cannot be expanded, and the newest wins between equals. */
  dedupeSpans(): number {
    const result = this.db
      .prepare(
        `DELETE FROM summaries WHERE id NOT IN (
           SELECT id FROM (
             SELECT s.id,
                    ROW_NUMBER() OVER (
                      PARTITION BY s.first_entry_id, s.last_entry_id, s.kind
                      ORDER BY (SELECT COUNT(*) FROM provenance p WHERE p.summary_id = s.id) DESC,
                               s.id DESC) AS rn
               FROM summaries s WHERE s.status = 'committed'
           ) WHERE rn = 1) AND status = 'committed'`,
      )
      .run();
    createSpanIndex(this.db);
    return Number(result.changes);
  }

  /** Mark entries that left the active branch, or clear the mark when a
   * navigation brings them back. Returns the rows the call actually changed, so
   * a metric can tell a real change from a no-op reconciliation. */
  setRemoved(entryIds: readonly string[], removedAt: number | null): number {
    if (entryIds.length === 0) return 0;
    const placeholders = entryIds.map(() => "?").join(",");
    const sql =
      removedAt === null
        ? `UPDATE messages SET removed_at = NULL WHERE removed_at IS NOT NULL AND entry_id IN (${placeholders})`
        : `UPDATE messages SET removed_at = ? WHERE removed_at IS NULL AND entry_id IN (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const result = removedAt === null ? stmt.run(...entryIds) : stmt.run(removedAt, ...entryIds);
    return Number(result.changes);
  }

  removedMessageCount(): number {
    return Number((this.stmts.countRemoved.get() as { c: number }).c);
  }

  messagesByIds(ids: number[]): StoredMessage[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, entry_id, role, text, tokens, timestamp, payload, removed_at FROM messages WHERE id IN (${placeholders}) ORDER BY rowid ASC`,
      )
      .all(...ids);
    return rows.map(rToMessage);
  }

  allMessages(): StoredMessage[] {
    const rows = this.stmts.allMessages.all();
    return rows.map(rToMessage);
  }

  entrySpan(): { first: string; last: string } | undefined {
    const row = this.stmts.entrySpan.get() as { first: string | null; last: string | null };
    return row.first === null || row.last === null
      ? undefined
      : { first: row.first, last: row.last };
  }

  coveredSize(summaryId: number): { tokens: number; messages: number } {
    const row = this.stmts.coveredSize.get(summaryId) as { tokens: number; messages: number };
    return { tokens: Number(row.tokens), messages: Number(row.messages) };
  }

  allSummaries(): SummaryNode[] {
    const rows = this.stmts.allSummaries.all(null);
    return rows.map(rToSummary);
  }

  messageCount(): number {
    return Number((this.stmts.countMessages.get() as { c: number }).c);
  }

  backup(backupPath: string): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    copyFileSync(this.dbPath, backupPath);
    try {
      chmodSync(backupPath, 0o600);
    } catch {}
  }

  /** The calibration recorded for a model. `undefined` is a model nothing has
   * sampled; a null ratio is one whose samples disagreed, which the caller reads
   * as "keep the constant" rather than "no data". */
  getModelState(modelKey: string): ModelState | undefined {
    const row = this.stmts.getModelState.get(modelKey) as
      | {
          chars_per_token: number | null;
          samples: number;
          context_window: number | null;
          window_source: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      charsPerToken: row.chars_per_token === null ? null : Number(row.chars_per_token),
      samples: Number(row.samples),
      contextWindow: row.context_window === null ? null : Number(row.context_window),
      windowSource: row.window_source,
    };
  }

  setModelState(modelKey: string, state: Pick<ModelState, "charsPerToken" | "samples">): void {
    this.stmts.setModelState.run(modelKey, state.charsPerToken, state.samples, Date.now());
  }

  /** Records the window a provider stated. Its own statement rather than part of
   * `setModelState`, because the two are learned at different moments: a later
   * calibration must not clear a window, and a window must not touch samples. */
  setModelWindow(modelKey: string, contextWindow: number, source: string): void {
    this.stmts.setModelWindow.run(modelKey, contextWindow, source, Date.now());
  }

  stats(): {
    messages: number;
    summaries: number;
    dbBytes: number;
    payloadMessages: number;
    payloadBytes: number;
    files: number;
    fileBytes: number;
    removedMessages: number;
  } {
    const m = this.stmts.countMessages.get() as { c: number };
    const s = this.stmts.countSummaries.get(null) as { c: number };
    const b = this.stmts.pageBytes.get() as { b: number };
    const p = this.stmts.payloadMessages.get() as { c: number };
    const pb = this.stmts.payloadBytes.get() as { b: number };
    const f = this.stmts.countFiles.get() as { c: number };
    const fb = this.stmts.sumFileBytes.get() as { b: number };
    return {
      messages: m.c,
      summaries: s.c,
      dbBytes: Number(b.b),
      payloadMessages: p.c,
      payloadBytes: Number(pb.b),
      files: f.c,
      fileBytes: Number(fb.b),
      removedMessages: this.removedMessageCount(),
    };
  }
}

class RunView implements PassStore {
  constructor(
    private store: LcmStore,
    private token: string,
  ) {}

  hasEntry(entryId: string): boolean {
    return this.store.hasEntry(entryId);
  }

  spanBounds(entryIds: readonly string[]): { firstEntryId: string; lastEntryId: string } | null {
    return this.store.spanBounds(entryIds);
  }

  insertMessage(m: Parameters<IngestStore["insertMessage"]>[0]): number {
    return this.store.insertMessage(m);
  }

  insertFile(d: FileDescriptor, firstEntryId: string): void {
    this.store.insertFile(d, firstEntryId);
  }

  linkMessageFile(messageId: number, fileId: string): void {
    this.store.linkMessageFile(messageId, fileId);
  }

  uncoveredMessagesInSpan(firstEntryId: string, lastEntryId: string): StoredMessage[] {
    return this.store.uncoveredMessagesInSpan(firstEntryId, lastEntryId, this.token);
  }

  filesForMessages(ids: readonly number[]): Array<FileDescriptor & { messageId: number }> {
    return this.store.filesForMessages(ids);
  }

  frontier(firstEntryId: string, lastEntryId: string): SummaryNode[] {
    return this.store.frontier(firstEntryId, lastEntryId, this.token);
  }

  getSummary(id: number): SummaryNode | undefined {
    return this.store.getSummary(id, this.token);
  }

  parentSummaryIds(summaryId: number): number[] {
    return this.store.parentSummaryIds(summaryId, this.token);
  }

  fileIdsForSummaries(ids: readonly number[]): string[] {
    return this.store.fileIdsForSummaries(ids);
  }

  insertSummary(s: InsertSummaryInput): InsertSummaryResult {
    return this.store.insertSummary({ ...s, run: this.token });
  }

  updateSummaryText(id: number, text: string, tokens: number): void {
    this.store.updateSummaryText(id, text, tokens);
  }

  setThoroughText(id: number, thoroughText: string): void {
    this.store.setThoroughText(id, thoroughText);
  }
}

function rToFile(r: Record<string, unknown>): FileDescriptor {
  return {
    fileId: String(r.file_id),
    path: String(r.path),
    bytes: Number(r.bytes),
    sha256: String(r.sha256),
    kind: isFileKind(r.kind) ? r.kind : "text",
    preview: String(r.preview),
  };
}

function rToMessage(r: Record<string, unknown>): StoredMessage {
  return {
    id: Number(r.id),
    entryId: String(r.entry_id),
    role: normalizeRole(String(r.role)),
    text: String(r.text),
    tokens: Number(r.tokens),
    timestamp: Number(r.timestamp),
    ...(typeof r.payload === "string" ? { payload: r.payload } : {}),
    ...(r.removed_at == null ? {} : { removedAt: Number(r.removed_at) }),
  };
}

function rToSummary(r: Record<string, unknown>): SummaryNode {
  return {
    id: Number(r.id),
    kind: r.kind === "condensed" ? "condensed" : "leaf",
    text: String(r.text),
    tokens: Number(r.tokens),
    depth: Number(r.depth),
    firstEntryId: String(r.first_entry_id),
    lastEntryId: String(r.last_entry_id),
    createdAt: Number(r.created_at),
    ...(typeof r.thorough_text === "string"
      ? { thoroughText: r.thorough_text, thoroughTokens: Number(r.thorough_tokens) }
      : {}),
  };
}

const CREATE_SPAN_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_span ON summaries(first_entry_id, last_entry_id, kind)";
