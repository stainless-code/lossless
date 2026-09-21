import type { FileDescriptor } from "./files.ts";
import {
  compilePattern,
  type CompiledPattern,
  PATTERN_DEADLINE_MS,
  PATTERN_PAGE_ROWS,
  PATTERN_ROW_CHARS,
  scanRows,
  type PatternScanOutcome,
} from "./pattern-scan.ts";
import type { LcmStore, StoredMessage, SummaryNode } from "./store.ts";

/**
 * Every view masks stored text with the injected `redact` before it is cut down
 * to its window, never after. A mask applied to an already truncated string
 * cannot see a value that straddles the cut, so it would leak the fragment.
 * Metadata built from ids, counts, and token costs is not text from the session
 * and is never masked.
 */

const MAX_LINE_CHARS = 400;
const RESULT_BUDGET_CHARS = 30_000;
export const GREP_PAGE_HITS = 20;

export type ViewResult =
  | { ok: true; text: string; details: Record<string, unknown> }
  | { ok: false; text: string };

export function grepView(
  store: LcmStore,
  redact: (text: string) => string,
  params: {
    query?: string;
    pattern?: string;
    caseSensitive?: boolean;
    offset?: number;
    limit?: number;
    summaryId?: number;
    includeRemoved?: boolean;
    /** Resume a pattern scan after this entry id, which is what a deadline stop
     * names. A page cannot express where a clock ran out. */
    after?: string;
    now?: () => number;
  },
): ViewResult {
  let withinMessageIds: Set<number> | undefined;
  if (params.summaryId !== undefined) {
    if (!store.getSummary(params.summaryId)) {
      return { ok: false, text: `No summary with id ${params.summaryId}.` };
    }
    withinMessageIds = new Set(store.coveredMessageIds(params.summaryId));
  }
  const limit = params.limit ?? GREP_PAGE_HITS;
  const offset = Math.max(0, params.offset ?? 0);
  const includeRemoved = params.includeRemoved === true;
  if (params.pattern !== undefined && params.query !== undefined) {
    return { ok: false, text: "Pass query or pattern, not both." };
  }
  if (params.pattern !== undefined) {
    let afterRowId = 0;
    if (params.after !== undefined) {
      const row = store.messageByEntryId(params.after);
      if (!row) return { ok: false, text: `No stored message with entry id ${params.after}.` };
      afterRowId = row.id;
    }
    return patternView(store, redact, {
      pattern: params.pattern,
      caseSensitive: params.caseSensitive === true,
      offset,
      limit,
      withinMessageIds,
      includeRemoved,
      afterRowId,
      now: params.now ?? Date.now,
    });
  }
  if (params.after !== undefined) {
    return { ok: false, text: "after resumes a pattern scan; pass pattern rather than query." };
  }
  if (params.query === undefined) {
    return { ok: false, text: "Pass a query (FTS5) or a pattern (regular expression)." };
  }
  let pattern = params.query;
  let hits: ReturnType<LcmStore["grep"]> | undefined;
  // FTS5 rejects some syntax (unbalanced quotes, stray operators) with an
  // error, so the same query is retried as a quoted phrase.
  const search = (query: string, removed: boolean, off: number) => {
    try {
      return store.grep(query, { limit, offset: off, withinMessageIds, includeRemoved: removed });
    } catch {
      return undefined;
    }
  };
  hits = search(pattern, includeRemoved, offset);
  if (hits === undefined) {
    pattern = JSON.stringify(params.query);
    hits = search(pattern, includeRemoved, offset);
  }
  if (hits === undefined) {
    return {
      ok: false,
      text: `Invalid search query ${JSON.stringify(params.query)}; try simpler keywords.`,
    };
  }
  if (hits.length === 0) {
    // A search that finds nothing because every match left the active path is
    // worth telling apart from one that finds nothing at all; the probe stops
    // at one hit, so no count is claimed.
    const hidden = includeRemoved ? [] : (search(pattern, true, offset) ?? []);
    if (hidden.length > 0) {
      return {
        ok: true,
        text: `Match(es) for ${JSON.stringify(params.query)} exist on a branch that left the active path; pass include_removed to read them.`,
        details: { hits: 0, removed: hidden.length },
      };
    }
    return {
      ok: true,
      text: `No matches for ${JSON.stringify(params.query)} in session history.`,
      details: { hits: 0 },
    };
  }
  let budget = RESULT_BUDGET_CHARS;
  const total = store.grepCount(pattern, { withinMessageIds, includeRemoved });
  const lines: string[] = [
    total === undefined || total <= limit
      ? `Found ${hits.length} match(es):`
      : `Match(es) ${offset + 1}..${offset + hits.length} of ${total}:`,
  ];
  for (const h of hits) {
    if (budget <= 0) {
      lines.push(`… ${hits.length - lines.length + 1} more (narrow your query)`);
      break;
    }
    const pointer = h.coveringSummaryId === undefined ? "" : ` #${h.coveringSummaryId}`;
    const removed = h.removed === true ? " [removed]" : "";
    const flat = redact(h.text.replace(/\s+/g, " "));
    const dropped = flat.length - MAX_LINE_CHARS;
    const shown =
      dropped > 0
        ? `${flat.slice(0, MAX_LINE_CHARS)} [lcm:more ${dropped} chars; read them with lcm_expand_query({entry_id:"${h.entryId}"})]`
        : flat;
    const line = `[${h.entryId}] (${h.role})${pointer}${removed} ${shown}`;
    budget -= line.length;
    lines.push(line);
  }
  const seen = offset + hits.length;
  if (total !== undefined && seen < total) {
    lines.push(`… ${total - seen} more; pass offset ${seen} for the next page.`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    details: { hits: hits.length, offset, ...(total === undefined ? {} : { total }) },
  };
}

function patternView(
  store: LcmStore,
  redact: (text: string) => string,
  params: {
    pattern: string;
    caseSensitive: boolean;
    offset: number;
    limit: number;
    withinMessageIds?: ReadonlySet<number>;
    includeRemoved: boolean;
    afterRowId: number;
    now: () => number;
  },
): ViewResult {
  const compiled = compilePattern(params.pattern, params.caseSensitive);
  if (!compiled.ok) return { ok: false, text: compiled.reason };
  const deadlineAt = params.now() + PATTERN_DEADLINE_MS;
  const outcome = scanPaged(store, compiled.pattern, params, deadlineAt);
  const lines: string[] = [];
  if (outcome.hits.length === 0) {
    // A miss is a documented outcome, not silence: what was scanned is the
    // difference between "no match" and "stopped before the match".
    lines.push(
      `No matches for pattern ${JSON.stringify(params.pattern)} in ${outcome.rows} stored message(s) scanned${scanNote(outcome)}.`,
    );
  } else {
    lines.push(
      `Pattern match(es) ${params.offset + 1}..${params.offset + outcome.hits.length}${outcome.more ? " or more" : ""} in ${outcome.rows} stored message(s) scanned:`,
    );
  }
  let budget = RESULT_BUDGET_CHARS;
  for (const hit of outcome.hits) {
    if (budget <= 0) break;
    const pointer = `${hit.row.entryId} (${hit.row.role})${hit.row.removed ? " [removed]" : ""}`;
    const flat = redact(hit.row.text.replace(/\s+/g, " "));
    const more = hit.matches > 1 ? ` (+${hit.matches - 1} more in this row)` : "";
    const cut = hit.partial
      ? ` [lcm:scan-partial ${hit.scannedChars} of ${hit.row.text.length} chars]`
      : "";
    const dropped = flat.length - MAX_LINE_CHARS;
    const shown =
      dropped > 0
        ? `${flat.slice(0, MAX_LINE_CHARS)} [lcm:more ${dropped} chars; read them with lcm_expand_query({entry_id:"${hit.row.entryId}"})]`
        : flat;
    const line = `[${pointer}]${cut} ${shown}${more}`;
    budget -= line.length;
    lines.push(line);
  }
  if (outcome.more) {
    lines.push(
      `… more matches exist; pass offset ${params.offset + outcome.hits.length} for the next page.`,
    );
  }
  if (outcome.stopped === "deadline" && outcome.lastEntryId !== undefined) {
    lines.push(
      `… scanning stopped at ${PATTERN_DEADLINE_MS}ms after ${outcome.rows} message(s); pass after "${outcome.lastEntryId}" to continue from there, or narrow the pattern.`,
    );
  }
  return {
    ok: true,
    text: lines.join("\n"),
    details: {
      hits: outcome.hits.length,
      offset: params.offset,
      ...(outcome.partialRows > 0 ? { partialRows: outcome.partialRows } : {}),
      // Only a deadline needs a resume point: a full page continues by offset,
      // and a finished scan has nowhere to resume.
      ...(outcome.stopped === "deadline" && outcome.lastEntryId !== undefined
        ? { after: outcome.lastEntryId }
        : {}),
      stopped: outcome.stopped,
    },
  };
}

function scanNote(outcome: PatternScanOutcome): string {
  const parts: string[] = [];
  if (outcome.stopped === "deadline") parts.push(`stopped at ${PATTERN_DEADLINE_MS}ms`);
  if (outcome.partialRows > 0) {
    parts.push(
      `${outcome.partialRows} row(s) longer than ${PATTERN_ROW_CHARS} chars, scanned to the cap`,
    );
  }
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

function scanPaged(
  store: LcmStore,
  pattern: CompiledPattern,
  params: {
    offset: number;
    limit: number;
    withinMessageIds?: ReadonlySet<number>;
    includeRemoved: boolean;
    afterRowId: number;
    now: () => number;
  },
  deadlineAt: number,
): PatternScanOutcome {
  let cursor = params.afterRowId;
  const collected: PatternScanOutcome = {
    hits: [],
    rows: 0,
    partialRows: 0,
    more: false,
    stopped: "end",
  };
  let skipped = 0;
  for (;;) {
    const page = store.messagePage(cursor, PATTERN_PAGE_ROWS, {
      withinMessageIds: params.withinMessageIds,
      includeRemoved: params.includeRemoved,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.rowid;
    const part = scanRows(page, {
      pattern,
      offset: Math.max(0, params.offset - skipped),
      limit: params.limit - collected.hits.length,
      perRowChars: PATTERN_ROW_CHARS,
      deadlineAt,
      now: params.now,
    });
    collected.rows += part.rows;
    collected.partialRows += part.partialRows;
    collected.hits.push(...part.hits);
    skipped += part.rows;
    collected.lastRowId = part.lastRowId;
    collected.lastEntryId = part.lastEntryId;
    if (part.stopped === "deadline") {
      collected.stopped = "deadline";
      break;
    }
    if (part.more) {
      collected.more = true;
      collected.stopped = "page";
      break;
    }
  }
  return collected;
}

export function describeView(
  store: LcmStore,
  redact: (text: string) => string,
  id: number,
): ViewResult {
  const node = store.getSummary(id);
  if (!node) return { ok: false, text: `No summary with id ${id}.` };
  const children = childNodes(store, node.id);
  const parents = store.parentSummaryIds(node.id);
  const files = store.filesForSummaries([node.id]);
  const ids = (xs: number[]) => xs.map((x) => `#${x}`).join(", ");
  const costs = nodeCosts(store, node, children);
  const lines = [
    `Summary #${node.id} (${node.kind}, depth ${node.depth}, ${node.tokens} tokens)`,
    `Span: ${node.firstEntryId} .. ${node.lastEntryId}`,
    `Costs: source ${costs.source} tokens across ${costs.messages} messages; subtree ${costs.subtree} tokens`,
    ...((node.thoroughText ?? "") === ""
      ? []
      : [`Tiers: thorough ${node.thoroughTokens} tokens (shown), terse ${node.tokens} tokens`]),
    ...(files.length > 0 ? [`Files: ${files.map(fileLine).join("; ")}`] : []),
    ...(children.length > 0 ? [`Children: ${ids(children.map((c) => c.id))}`] : []),
    ...(parents.length > 0 ? [`Parents: ${ids(parents)}`] : []),
    ...(children.length > 0
      ? ["Child costs:", ...children.map((c) => `  ${costLine(store, c)}`)]
      : []),
    "",
    redact(node.thoroughText ?? node.text),
  ];
  return {
    ok: true,
    text: lines.join("\n"),
    details: { id: node.id, kind: node.kind, depth: node.depth, tokens: node.tokens },
  };
}

/** A message read: the entry must be covered when the caller named a summary,
 * which catches a mismatched id instead of silently reading a different entry. */
function readMessage(
  store: LcmStore,
  redact: (text: string) => string,
  params: { id?: number; entryId: string; charOffset: number; maxChars: number },
): ViewResult {
  if (params.id !== undefined) {
    if (!store.getSummary(params.id)) {
      return { ok: false, text: `No summary with id ${params.id}.` };
    }
    const covered = store.messageByEntryId(params.entryId);
    if (!covered || !store.coveredMessageIds(params.id).includes(covered.id)) {
      return {
        ok: false,
        text: `Message ${params.entryId} is not covered by summary #${params.id}.`,
      };
    }
    return readWindow(covered, redact, params);
  }
  const message = store.messageByEntryId(params.entryId);
  if (!message) return { ok: false, text: `No stored message with entry id ${params.entryId}.` };
  return readWindow(message, redact, params);
}

/** One message as a window of its readable body. A message that left the active
 * branch is read anyway, with a marker: the caller asked for that id, and
 * retention is the product. */
function readWindow(
  message: StoredMessage,
  redact: (text: string) => string,
  params: { charOffset: number; maxChars: number },
): ViewResult {
  const body = redact(readableBody(message));
  const offset = Math.max(0, Math.min(params.charOffset, body.length));
  const window = body.slice(offset, offset + Math.max(1, params.maxChars));
  const end = offset + window.length;
  const more = end < body.length;
  const raw = message.payload === undefined ? "" : " raw blocks";
  const header = `${messageHeader(message.entryId, message.role)}${raw} chars ${offset}..${end} of ${body.length}${more ? `, continue with entry_id "${message.entryId}" and char_offset ${end}` : ""}`;
  const removed =
    message.removedAt === undefined
      ? ""
      : `[lcm:removed ${message.entryId} is not on the active branch; text retained]\n`;
  return {
    ok: true,
    text: `${removed}${header}\n\n${window}`,
    details: {
      total: body.length,
      offset,
      entryId: message.entryId,
      ...(message.removedAt === undefined ? {} : { removed: true }),
    },
  };
}

/** List the summary's messages, or read one of them as a window of characters.
 * A message read without a summary names an entry directly, which is how an
 * entry that no leaf covers yet is read at all. */
export type ExpandParams =
  | { mode: "list"; id: number; offset: number; limit: number; maxChars: number }
  | { mode: "message"; id?: number; entryId: string; charOffset: number; maxChars: number };

export function expandView(
  store: LcmStore,
  redact: (text: string) => string,
  params: ExpandParams,
): ViewResult {
  if (params.mode === "message") return readMessage(store, redact, params);
  const node = store.getSummary(params.id);
  if (!node) return { ok: false, text: `No summary with id ${params.id}.` };
  const messages = store.messagesByIds(store.coveredMessageIds(params.id));
  const offset = Math.max(0, params.offset);
  const slice = messages.slice(offset, offset + Math.max(0, params.limit));
  const parts: string[] = [];
  for (const m of slice) {
    parts.push(
      `${messageHeader(m.entryId, m.role)}\n${clippedMessage(m.entryId, redact(readableBody(m)), params.maxChars)}`,
    );
  }
  const hasMore = offset + slice.length < messages.length;
  const listed = `Summary #${params.id} → ${messages.length} original messages (showing ${slice.length} from ${offset})${hasMore ? ", use offset to page" : ""}`;
  return {
    ok: true,
    text: `${listed}\n\n${parts.join("\n\n")}`,
    details: { total: messages.length, offset },
  };
}

export function historyManifest(store: LcmStore, limit: number): string {
  const span = store.entrySpan();
  if (!span) return "No history is stored yet.";
  const frontier = store.frontier(span.first, span.last);
  if (frontier.length === 0) {
    return `${store.messageCount()} messages, ${span.first} .. ${span.last}; no summaries yet, so lcm_grep searches the raw messages.`;
  }
  const shown = frontier.slice(-limit).reverse();
  const omitted = frontier.length - shown.length;
  return [
    `${frontier.length} top-level summaries cover messages ${span.first} .. ${span.last}${omitted > 0 ? ` (${omitted} older not listed)` : ""}:`,
    ...shown.map((n) => costLine(store, n)),
  ].join("\n");
}

function messageHeader(entryId: string, role: string): string {
  return `[${entryId}] (${role})`;
}

/** One file a node covers: its path, the opaque id, what the body is, and the
 * exploration summary the descriptor leads with, so a reader can choose a file
 * to open without reading any of them. */
function fileLine(f: FileDescriptor): string {
  const structure = f.preview.split("\n")[0] ?? "";
  const named =
    structure.length <= STRUCTURE_IN_DESCRIBE_CHARS
      ? structure
      : `${structure.slice(0, STRUCTURE_IN_DESCRIBE_CHARS)}…`;
  return `${f.path} (${f.fileId}, ${f.bytes} chars, ${f.kind}; ${named})`;
}

const STRUCTURE_IN_DESCRIBE_CHARS = 120;

function readableBody(m: StoredMessage): string {
  return m.payload ?? m.text;
}

function clippedMessage(entryId: string, text: string, maxChars: number): string {
  const bound = Math.max(1, maxChars);
  if (text.length <= bound) return text;
  const shown = text.slice(0, bound);
  return `${shown}\n[lcm:more ${text.length - shown.length} chars; read them with entry_id "${entryId}" and char_offset ${shown.length}]`;
}

function childNodes(store: LcmStore, id: number): SummaryNode[] {
  return store.childSummaryIds(id).flatMap((childId) => {
    const child = store.getSummary(childId);
    return child ? [child] : [];
  });
}

interface NodeCosts {
  source: number;
  messages: number;
  subtree: number;
}

/**
 * Source tokens are what a full expansion would cost; subtree tokens are one
 * level down. A bounded reader needs both before it commits to an expansion.
 */
function nodeCosts(store: LcmStore, node: SummaryNode, children: SummaryNode[]): NodeCosts {
  const size = store.coveredSize(node.id);
  return {
    source: size.tokens,
    messages: size.messages,
    subtree: node.tokens + children.reduce((n, c) => n + c.tokens, 0),
  };
}

function costLine(store: LcmStore, node: SummaryNode): string {
  const costs = nodeCosts(store, node, childNodes(store, node.id));
  return `#${node.id} ${node.kind} depth ${node.depth}, ${node.tokens} tokens, source ${costs.source}, ${node.firstEntryId} .. ${node.lastEntryId}`;
}
