import { existsSync } from "node:fs";
import { basename } from "node:path";

import {
  describeView,
  expandView,
  grepView,
  historyManifest,
  LcmStore,
  StaleStoreError,
} from "lossless-core";

/** Max bytes one dump prints; callers copy the file when they need more. */
export const DUMP_MAX_BYTES = 16_384;
/** Summaries described in full; the header still counts the rest. */
export const DUMP_MAX_SUMMARIES = 10;
/** Metric rows kept from the tail of the session's rows. */
export const DUMP_MAX_METRIC_ROWS = 20;
/** Top-level summaries the manifest names. */
export const DUMP_MAX_HISTORY = 20;
/** Messages read as windows from the first summary. */
export const DUMP_MAX_SAMPLE_MESSAGES = 3;
/** Chars one sampled message window holds. */
export const DUMP_SAMPLE_CHARS = 400;

/** Why a sidecar could not be dumped. Each reason is a count the caller
 * reports, never an error it raises. */
export type DumpSkipReason = "missing" | "unreadable" | "older-generation";

export type SidecarDumpResult =
  | { status: "dumped"; text: string }
  | { status: "skipped"; reason: DumpSkipReason; detail: string };

export interface SidecarDumpOptions {
  /** Sidecar file to open read-only. Never created when absent. */
  readonly path: string;
  /** Session id naming the dump and filtering metric rows. */
  readonly sessionId: string;
  /** Masks secret-shaped text on every displayed seam. */
  readonly redact: (text: string) => string;
  /** Include matches from a branch that left the active path. */
  readonly includeRemoved?: boolean;
  /** Metric rows for this sidecar directory, oldest first. */
  readonly metricRows?: readonly Record<string, unknown>[];
  /** Optional FTS5 query sampled through grepView. */
  readonly sampleQuery?: string;
}

/** Read-only dump of one session sidecar plus its metrics. Opens the file
 * with `queryOnly`, so SQLite refuses writes, and closes it before returning.
 * An older generation reports a named skip instead of migrating. */
export function dumpSidecar(options: SidecarDumpOptions): SidecarDumpResult {
  if (!existsSync(options.path)) {
    return {
      status: "skipped",
      reason: "missing",
      detail: `no sidecar at ${basename(options.path)}`,
    };
  }
  let store: LcmStore | undefined;
  try {
    store = new LcmStore(options.path, { queryOnly: true });
  } catch (error) {
    if (error instanceof StaleStoreError) {
      return {
        status: "skipped",
        reason: "older-generation",
        detail:
          `generation ${error.generation} is older than this build; ` +
          `run migrate first (no rows were changed)`,
      };
    }
    return {
      status: "skipped",
      reason: "unreadable",
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  }
  try {
    return { status: "dumped", text: buildDump(store, options) };
  } catch (error) {
    return {
      status: "skipped",
      reason: "unreadable",
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
    };
  } finally {
    try {
      store.close();
    } catch {}
  }
}

function buildDump(store: LcmStore, options: SidecarDumpOptions): string {
  const includeRemoved = options.includeRemoved === true;
  const stats = store.stats();
  const removed = stats.removedMessages > 0 ? ` (${stats.removedMessages} removed, retained)` : "";
  const head = [
    `LCM sidecar dump: ${options.sessionId}`,
    `store: ${basename(options.path)}, generation ${store.generation}, ` +
      `${stats.messages} messages${removed}, ${stats.summaries} summaries, ` +
      `${(stats.dbBytes / 1024).toFixed(0)} KB`,
    `history:`,
    historyManifest(store, DUMP_MAX_HISTORY),
  ];
  const summaries = store.allSummaries().slice(0, DUMP_MAX_SUMMARIES);
  const totalSummaries = store.allSummaries().length;
  const sections: string[] = [...head];
  if (summaries.length > 0) {
    sections.push(`summaries: ${summaries.length} shown of ${totalSummaries}`);
    for (const summary of summaries) {
      const view = describeView(store, options.redact, summary.id);
      sections.push(view.ok ? view.text : `Summary #${summary.id}: unreadable.`);
    }
    const first = summaries[0]!;
    const list = expandView(store, options.redact, {
      mode: "list",
      id: first.id,
      offset: 0,
      limit: DUMP_MAX_SAMPLE_MESSAGES,
      maxChars: DUMP_SAMPLE_CHARS,
    });
    sections.push(`messages (summary #${first.id}):`, list.ok ? list.text : "No messages.");
    const covered = store.coveredMessageIds(first.id);
    const sampled = store.messagesByIds(covered.slice(0, DUMP_MAX_SAMPLE_MESSAGES));
    for (const message of sampled) {
      const window = expandView(store, options.redact, {
        mode: "message",
        entryId: message.entryId,
        charOffset: 0,
        maxChars: DUMP_SAMPLE_CHARS,
      });
      sections.push(window.ok ? window.text : `No stored message ${message.entryId}.`);
    }
  } else {
    sections.push("summaries: none stored yet.");
  }
  if (options.sampleQuery !== undefined && options.sampleQuery.length > 0) {
    const found = grepView(store, options.redact, {
      query: options.sampleQuery,
      limit: DUMP_MAX_SAMPLE_MESSAGES,
      includeRemoved,
    });
    sections.push(
      `search ${JSON.stringify(options.sampleQuery)}${includeRemoved ? " (including removed)" : ""}:`,
      found.text,
    );
  }
  const rows = (options.metricRows ?? []).filter((row) => row.session === options.sessionId);
  const shown = rows.slice(Math.max(0, rows.length - DUMP_MAX_METRIC_ROWS));
  sections.push(`metrics: ${rows.length} row(s) for this session, ${shown.length} shown`);
  for (const row of shown) sections.push(`  ${JSON.stringify(sanitizeRow(row, options.redact))}`);
  sections.push(
    `omitted: no absolute paths, message bodies past ${DUMP_SAMPLE_CHARS} chars per sample, ` +
      `summaries past ${DUMP_MAX_SUMMARIES}, metric rows past ${DUMP_MAX_METRIC_ROWS}. ` +
      `Removed rows carry [removed]; read them with include_removed.`,
  );
  const text = sections.join("\n");
  if (Buffer.byteLength(text, "utf8") <= DUMP_MAX_BYTES) return text;
  return clip(text);
}

/** Redact string seams in one metric row; keys and stub pointers stay intact. */
function sanitizeRow(
  row: Record<string, unknown>,
  redact: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = sanitizeValue(value, redact);
  return out;
}

function sanitizeValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(item, redact);
    }
    return out;
  }
  return value;
}

function clip(text: string): string {
  const marker = `... truncated at the ${DUMP_MAX_BYTES} byte limit`;
  const budget = DUMP_MAX_BYTES - Buffer.byteLength(marker, "utf8") - 1;
  let kept = "";
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budget) break;
    kept += (kept.length === 0 ? "" : "\n") + line;
    used += cost;
  }
  return `${kept}\n${marker}`;
}
