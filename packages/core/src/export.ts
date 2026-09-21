import type { FileKind } from "./files.ts";
import type { LcmStore, LcmRole, StoredMessage, SummaryNode } from "./store.ts";

/** The format this build writes, and the only one it reads. A range reads as a
 * compatibility promise while the row readers ignore the number, and the store,
 * not the file, holds the truth: a file that does not fit is re-exported. */
export const EXPORT_VERSION = 1;

/** A message row: the store's numeric id is not portable, so the entry id is
 * the handle an importer resolves through. */
export interface ExportMessageRow {
  v: number;
  rowType: "message";
  entryId: string;
  role: LcmRole;
  text: string;
  tokens: number;
  timestamp: number;
  payload?: string;
}

/** A summary row. Provenance makes a summary usable: a leaf names the messages
 * it covers, a condensed node names children by file position, since ids are
 * assigned on import. `createdAt` is not carried, because the store assigns its
 * own and a field no import can restore would be a lie in the file. A run in
 * flight is not exported: what this returns is committed memory, so a pass still
 * holding pending rows is invisible here and an import waits for it. */
export interface ExportSummaryRow {
  v: number;
  rowType: "summary";
  ordinal: number;
  kind: "leaf" | "condensed";
  text: string;
  tokens: number;
  depth: number;
  firstEntryId: string;
  lastEntryId: string;
  messageEntryIds: string[];
  childOrdinals: number[];
}

export type ExportRow = ExportMessageRow | ExportSummaryRow | ExportFileRow;

export interface ExportFileRow {
  v: number;
  rowType: "file";
  fileId: string;
  path: string;
  bytes: number;
  sha256: string;
  kind: FileKind;
  preview: string;
  entryIds: string[];
}

export function exportTranscript(store: LcmStore): {
  messages: StoredMessage[];
  summaries: SummaryNode[];
  toJSONL: () => string;
} {
  const messages = store.allMessages();
  const summaries = store.allSummaries();
  const files = store.allFiles();
  const ordinalOf = new Map(summaries.map((s, i) => [s.id, i]));
  const rows: ExportRow[] = [
    ...messages.map((m) => ({
      v: EXPORT_VERSION,
      rowType: "message" as const,
      entryId: m.entryId,
      role: m.role,
      text: m.text,
      tokens: m.tokens,
      timestamp: m.timestamp,
      ...(m.payload === undefined ? {} : { payload: m.payload }),
    })),
    ...summaries.map((s, ordinal) => ({
      v: EXPORT_VERSION,
      rowType: "summary" as const,
      ordinal,
      kind: s.kind,
      text: s.text,
      tokens: s.tokens,
      depth: s.depth,
      firstEntryId: s.firstEntryId,
      lastEntryId: s.lastEntryId,
      messageEntryIds:
        s.kind === "leaf"
          ? store.messagesByIds(store.coveredMessageIds(s.id)).map((m) => m.entryId)
          : [],
      childOrdinals: store.childSummaryIds(s.id).flatMap((id) => {
        const child = ordinalOf.get(id);
        return child === undefined ? [] : [child];
      }),
    })),
    ...files.map((f) => ({
      v: EXPORT_VERSION,
      rowType: "file" as const,
      fileId: f.fileId,
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      kind: f.kind,
      preview: f.preview,
      entryIds: f.entryIds,
    })),
  ];
  return {
    messages,
    summaries,
    toJSONL: () => rows.map((r) => JSON.stringify(r)).join("\n"),
  };
}
