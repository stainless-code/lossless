import {
  EXPORT_VERSION,
  type ExportFileRow,
  type ExportMessageRow,
  type ExportRow,
  type ExportSummaryRow,
} from "./export.ts";
import { FILE_KINDS, isFileKind, type FileDescriptor } from "./files.ts";
import { ingestEntries } from "./ingest.ts";
import { normalizeRole, type LcmStore } from "./store.ts";

export interface ImportResult {
  messagesInserted: number;
  messagesSkipped: number;
  summariesInserted: number;
  summariesSkipped: number;
  /** Set when the import was refused, with the text naming the reason. The
   * counters say what landed before it was: a refusal ahead of the summary loop
   * writes nothing, and one inside it names the rows that did land. */
  refused?: string;
}

export type ParsedExport = { rows: ExportRow[] } | { error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function rowsOf(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(str) ? (v as string[]) : undefined;
}

function ordinalsOf(v: unknown): number[] | undefined {
  return Array.isArray(v) && v.every(num) ? (v as number[]) : undefined;
}

/** Read a file written by `/lcm export`: every line is validated before any is
 * used, so a truncated or foreign file is refused without a partial import and
 * the caller can report a line number. */
export function parseExport(text: string): ParsedExport {
  const rows: ExportRow[] = [];
  const lines = text.split("\n");
  const ordinals = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    const where = `line ${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return { error: `${where} is not JSON` };
    }
    if (!isRecord(raw)) return { error: `${where} is not an object` };
    const version = raw["v"];
    if (!num(version) || version !== EXPORT_VERSION) {
      return {
        error: `${where} has version ${JSON.stringify(version)}; this build reads version ${EXPORT_VERSION}`,
      };
    }
    const rowType = raw["rowType"];
    if (rowType === "message") {
      const { entryId, role, text: body, tokens, timestamp, payload } = raw;
      if (!str(entryId) || !str(role) || !str(body) || !num(tokens) || !num(timestamp)) {
        return { error: `${where} is a message row missing a field` };
      }
      if (payload !== undefined && !str(payload)) {
        return { error: `${where} has a payload that is not a string` };
      }
      rows.push({
        v: EXPORT_VERSION,
        rowType: "message",
        entryId,
        role: normalizeRole(role),
        text: body,
        tokens,
        timestamp,
        ...(payload === undefined ? {} : { payload }),
      });
      continue;
    }
    if (rowType === "summary") {
      const {
        ordinal,
        kind,
        text: body,
        tokens,
        depth,
        firstEntryId,
        lastEntryId,
        messageEntryIds,
        childOrdinals,
      } = raw;
      if (kind !== "leaf" && kind !== "condensed") {
        return { error: `${where} names no summary kind` };
      }
      if (
        !num(ordinal) ||
        !str(body) ||
        !num(tokens) ||
        !num(depth) ||
        !str(firstEntryId) ||
        !str(lastEntryId)
      ) {
        return { error: `${where} is a summary row missing a field` };
      }
      const messageIds = rowsOf(messageEntryIds);
      const childIds = ordinalsOf(childOrdinals);
      if (!messageIds || !childIds) {
        return { error: `${where} has malformed provenance` };
      }
      if (ordinals.has(ordinal)) return { error: `${where} repeats ordinal ${ordinal}` };
      ordinals.add(ordinal);
      rows.push({
        v: EXPORT_VERSION,
        rowType: "summary",
        ordinal,
        kind,
        text: body,
        tokens,
        depth,
        firstEntryId,
        lastEntryId,
        messageEntryIds: messageIds,
        childOrdinals: childIds,
      });
      continue;
    }
    if (rowType === "file") {
      const { fileId, path, bytes, sha256, kind, preview, entryIds } = raw;
      if (!str(fileId) || !str(path) || !num(bytes) || !str(sha256) || !str(preview)) {
        return { error: `${where} is a file row missing a field` };
      }
      if (!isFileKind(kind)) {
        return {
          error: `${where} has file kind ${JSON.stringify(kind)}; this build reads ${FILE_KINDS.join(", ")}`,
        };
      }
      const entries = rowsOf(entryIds);
      if (!entries) return { error: `${where} has malformed entry ids` };
      rows.push({
        v: EXPORT_VERSION,
        rowType: "file",
        fileId,
        path,
        bytes,
        sha256,
        kind,
        preview,
        entryIds: entries,
      });
      continue;
    }
    return { error: `${where} has an unknown rowType` };
  }
  if (rows.length === 0) return { error: "the file holds no rows" };
  return { rows };
}

function provenanceProblem(rows: readonly ExportRow[]): string | undefined {
  const entries = new Set(
    rows.filter((r): r is ExportMessageRow => r.rowType === "message").map((r) => r.entryId),
  );
  for (const f of rows) {
    if (f.rowType !== "file") continue;
    for (const e of f.entryIds) {
      if (!entries.has(e))
        return `file ${f.fileId} came from entry ${e}, which the file does not hold`;
    }
  }
  const byOrdinal = new Map<number, ExportSummaryRow>();
  for (const r of rows) if (r.rowType === "summary") byOrdinal.set(r.ordinal, r);
  for (const s of byOrdinal.values()) {
    for (const e of s.messageEntryIds) {
      if (!entries.has(e))
        return `summary ${s.ordinal} covers message ${e}, which the file does not hold`;
    }
    for (const c of s.childOrdinals) {
      const child = byOrdinal.get(c);
      if (!child) return `summary ${s.ordinal} names child ${c}, which the file does not hold`;
      if (child.depth >= s.depth) {
        return `summary ${s.ordinal} names child ${c} at depth ${child.depth}, which is not below it`;
      }
    }
  }
  return undefined;
}

const REFUSED = (reason: string): ImportResult => ({
  messagesInserted: 0,
  messagesSkipped: 0,
  summariesInserted: 0,
  summariesSkipped: 0,
  refused: reason,
});

function fileDescriptor(f: ExportFileRow): FileDescriptor {
  return {
    fileId: f.fileId,
    path: f.path,
    bytes: f.bytes,
    sha256: f.sha256,
    kind: f.kind,
    preview: f.preview,
  };
}

export function importTranscript(store: LcmStore, rows: readonly ExportRow[]): ImportResult {
  // A pass's rows are pending and invisible to every reader, and an import writes
  // committed rows. A parent imported now could name a pending row as its child,
  // which a reap or an abandon would then leave dangling, so refuse instead. The
  // pass can run in another process, where this handle's own run list says
  // nothing, so the store answers for every live run it holds.
  if (store.hasLiveRun()) {
    return REFUSED("a compaction pass is in flight over this store; retry the import");
  }
  const messages = rows.filter((r) => r.rowType === "message");
  const summaries = rows
    .filter((r): r is ExportSummaryRow => r.rowType === "summary")
    .sort((a, b) => a.depth - b.depth || a.ordinal - b.ordinal);

  const problem = provenanceProblem(rows);
  if (problem) return REFUSED(problem);

  const exported = new Set(messages.map((m) => m.entryId));
  const foreign = store.allMessages().filter((m) => !exported.has(m.entryId));
  if (foreign.length > 0) {
    return REFUSED(
      `this store already holds ${foreign.length} message(s) the file does not name; import into an empty store instead`,
    );
  }

  const ingested = ingestEntries(
    store,
    messages.map((m) => ({
      entryId: m.entryId,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
      ...(m.payload === undefined ? {} : { payload: m.payload }),
    })),
  );
  const idByEntry = new Map(store.allMessages().map((m) => [m.entryId, m.id]));
  for (const f of rows) {
    if (f.rowType !== "file") continue;
    store.insertFile(fileDescriptor(f), f.entryIds[0] ?? "");
    for (const entryId of f.entryIds) {
      const messageId = idByEntry.get(entryId);
      if (messageId !== undefined) store.linkMessageFile(messageId, f.fileId);
    }
  }
  const idByOrdinal = new Map<number, number>();
  let summariesInserted = 0;
  let summariesSkipped = 0;
  for (const s of summaries) {
    const inserted = store.insertSummary({
      kind: s.kind,
      text: s.text,
      tokens: s.tokens,
      depth: s.depth,
      firstEntryId: s.firstEntryId,
      lastEntryId: s.lastEntryId,
      messageIds: s.messageEntryIds.flatMap((e) => {
        const id = idByEntry.get(e);
        return id === undefined ? [] : [id];
      }),
      childSummaryIds: s.childOrdinals.flatMap((o) => {
        const id = idByOrdinal.get(o);
        return id === undefined ? [] : [id];
      }),
    });
    idByOrdinal.set(s.ordinal, inserted.id);
    if (inserted.created) {
      summariesInserted++;
    } else if (!inserted.own) {
      // The span is held by a run that started after the gate above and is not
      // this store's committed memory, so its row can go away under the row this
      // import would build on it. Refuse rather than adopt an id nothing keeps.
      return {
        messagesInserted: ingested.inserted,
        messagesSkipped: ingested.skipped,
        summariesInserted,
        summariesSkipped,
        refused: "a compaction pass took a span this import needs while it ran; retry the import",
      };
    } else {
      summariesSkipped++;
    }
  }
  return {
    messagesInserted: ingested.inserted,
    messagesSkipped: ingested.skipped,
    summariesInserted,
    summariesSkipped,
  };
}
