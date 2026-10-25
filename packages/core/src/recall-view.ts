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
import { mechanicalToolNameOf } from "./util/summarizer-config.ts";

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

const LCM_ROLES = ["user", "assistant", "toolResult", "custom"] as const;

type GrepFilter = {
  role?: (typeof LCM_ROLES)[number];
  dateStart?: number;
  dateEnd?: number;
  toolName?: string;
};

function grepFilterProblem(filter: GrepFilter): string | undefined {
  if (filter.role !== undefined && !LCM_ROLES.includes(filter.role)) {
    return `Unknown role ${JSON.stringify(filter.role)}. Pass one of ${LCM_ROLES.join(", ")}.`;
  }
  for (const key of ["dateStart", "dateEnd"] as const) {
    const value = filter[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return `${key} must be a non-negative timestamp number.`;
    }
  }
  if (filter.toolName !== undefined && filter.toolName.trim().length === 0) {
    return "toolName must be a non-empty tool name.";
  }
  return undefined;
}

/** The `[tool:Name]` marker in front of a tool call's arguments, so a scoped
 * search needs no table or index. */
export function toolMarker(toolName: string): string {
  return `[tool:${toolName}]`;
}

/** Quote a string as one FTS5 phrase. Embedded quotes double; JSON.stringify
 * emits backslash escapes which FTS5 rejects. */
export function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** Rewrite an FTS5 query to its tool-scoped form. The marker passes as a quoted
 * phrase, which the FTS5 tokenizer splits the same way as the stored text, so
 * prose with the same adjacent words (for example "which tool read the file")
 * can also match. Anchoring to the row start would miss mixed blocks because
 * entryToText appends blocks in order, so the scoped search keeps this broader
 * match and callers read the hit to confirm the tool. */
export function withToolScope(query: string, toolName: string): string {
  return `(${query}) AND ${ftsPhrase(toolMarker(toolName))}`;
}

/** Row ids a tool scope covers: the call rows that name the tool plus the
 * toolResult rows that follow them. Pi stores a call and its result in
 * separate rows, so a same-row `query AND marker` FTS misses a word found
 * only in the result. A trailing run of toolResult rows after a marker row
 * belongs to that call batch; any other role ends the run, as does a
 * toolResult row that names a different tool. Bracket text is checked
 * directly so one row naming two tools anchors both, and
 * mechanicalToolNameOf covers the `tool <name>` and payload forms. */
export function toolScopeMessageIds(
  store: LcmStore,
  toolName: string,
  opts?: { includeRemoved?: boolean; withinMessageIds?: ReadonlySet<number> },
): Set<number> {
  const want = toolName.trim().toLowerCase();
  const out = new Set<number>();
  if (want.length === 0) return out;
  const scope = opts?.withinMessageIds;
  const includeRemoved = opts?.includeRemoved === true;
  const visible = store
    .allMessages()
    .filter(
      (m) =>
        (includeRemoved || m.removedAt === undefined) && (scope === undefined || scope.has(m.id)),
    );
  let open = false;
  for (const row of visible) {
    const namesTool =
      row.text.toLowerCase().includes(`[tool:${want}]`) ||
      mechanicalToolNameOf({ text: row.text, payload: row.payload }) === want;
    if (namesTool) {
      out.add(row.id);
      open = true;
      continue;
    }
    if (row.role === "toolResult" && open) {
      const other = mechanicalToolNameOf({ text: row.text, payload: row.payload }) ?? "";
      if ((other.length > 0 && other !== want) || /\[tool:/i.test(row.text)) {
        open = false;
        continue;
      }
      out.add(row.id);
      continue;
    }
    if (row.role !== "toolResult") open = false;
  }
  return out;
}

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
    /** Tool the continuation marker names. Defaults to `lcm_expand_query`. */
    expandTool?: string;
    role?: GrepFilter["role"];
    dateStart?: number;
    dateEnd?: number;
    /** Query searches only; with a pattern it is refused. */
    toolName?: string;
  },
): ViewResult {
  let withinMessageIds: Set<number> | undefined;
  if (params.summaryId !== undefined) {
    if (!store.getSummary(params.summaryId)) {
      return { ok: false, text: `No summary with id ${params.summaryId}.` };
    }
    withinMessageIds = new Set(store.coveredMessageIds(params.summaryId));
  }
  const filterProblem = grepFilterProblem({
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.dateStart === undefined ? {} : { dateStart: params.dateStart }),
    ...(params.dateEnd === undefined ? {} : { dateEnd: params.dateEnd }),
    ...(params.toolName === undefined ? {} : { toolName: params.toolName }),
  });
  if (filterProblem !== undefined) return { ok: false, text: filterProblem };
  const grepOpts = {
    withinMessageIds,
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.dateStart === undefined ? {} : { dateStart: params.dateStart }),
    ...(params.dateEnd === undefined ? {} : { dateEnd: params.dateEnd }),
  };
  const limit = params.limit ?? GREP_PAGE_HITS;
  const offset = Math.max(0, params.offset ?? 0);
  const includeRemoved = params.includeRemoved === true;
  const expandTool = params.expandTool ?? "lcm_expand_query";
  if (params.pattern !== undefined && params.query !== undefined) {
    return { ok: false, text: "Pass query or pattern, not both." };
  }
  if (params.pattern !== undefined) {
    if (params.toolName !== undefined) {
      return { ok: false, text: "toolName scopes a query search. Pass query rather than pattern." };
    }
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
      includeRemoved,
      afterRowId,
      now: params.now ?? Date.now,
      expandTool,
      ...grepOpts,
    });
  }
  if (params.after !== undefined) {
    return { ok: false, text: "after resumes a pattern scan; pass pattern rather than query." };
  }
  if (params.query === undefined) {
    return { ok: false, text: "Pass a query (FTS5) or a pattern (regular expression)." };
  }
  if (params.toolName !== undefined) {
    return toolScopedView(store, redact, {
      query: params.query,
      toolName: params.toolName,
      limit,
      offset,
      includeRemoved,
      expandTool,
      withinMessageIds,
      ...(params.role === undefined ? {} : { role: params.role }),
      ...(params.dateStart === undefined ? {} : { dateStart: params.dateStart }),
      ...(params.dateEnd === undefined ? {} : { dateEnd: params.dateEnd }),
    });
  }
  const scoped = params.query;
  let pattern = scoped;
  let hits: ReturnType<LcmStore["grep"]> | undefined;
  // FTS5 rejects some syntax (unbalanced quotes, stray operators) with an
  // error, so the same query is retried as a quoted phrase.
  const search = (query: string, removed: boolean, off: number) => {
    try {
      return store.grep(query, { limit, offset: off, includeRemoved: removed, ...grepOpts });
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
  const total = store.grepCount(pattern, { includeRemoved, ...grepOpts });
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
        ? `${flat.slice(0, MAX_LINE_CHARS)} [lcm:more ${dropped} chars; read them with ${expandTool}({entry_id:"${h.entryId}"})]`
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

/** A scoped FTS search that stays complete. `store.grep` applies its SQL
 * LIMIT before it intersects the id set, so one bounded call can miss rows
 * that rank past the window. The unscoped count bounds the rank order, so one
 * fetch of that size holds every in-scope match and the caller pages the
 * filtered set. Rank order is preserved. Throws on invalid FTS5 syntax, like
 * `store.grep`, so callers keep their quoted-phrase fallback. */
export function scopedGrepAll(
  store: LcmStore,
  pattern: string,
  opts: {
    includeRemoved: boolean;
    role?: GrepFilter["role"];
    dateStart?: number;
    dateEnd?: number;
    scoped: ReadonlySet<number>;
  },
): ReturnType<LcmStore["grep"]> {
  if (opts.scoped.size === 0) return [];
  const unscoped = {
    includeRemoved: opts.includeRemoved,
    ...(opts.role === undefined ? {} : { role: opts.role }),
    ...(opts.dateStart === undefined ? {} : { dateStart: opts.dateStart }),
    ...(opts.dateEnd === undefined ? {} : { dateEnd: opts.dateEnd }),
  };
  const totalRaw = store.grepCount(pattern, unscoped);
  if (totalRaw === 0) return [];
  return store.grep(pattern, {
    limit: totalRaw ?? opts.scoped.size,
    offset: 0,
    ...unscoped,
    withinMessageIds: opts.scoped,
  });
}

/** A tool-scoped query search: the FTS query runs inside the rows the tool
 * owns (its call rows plus the toolResult rows after them), so a word found
 * only in a Pi result still matches. Paging and totals come from that row
 * set, and the removed-branch probe reads the same set with removed rows. */
function toolScopedView(
  store: LcmStore,
  redact: (text: string) => string,
  params: {
    query: string;
    toolName: string;
    limit: number;
    offset: number;
    includeRemoved: boolean;
    expandTool: string;
    withinMessageIds?: ReadonlySet<number>;
    role?: GrepFilter["role"];
    dateStart?: number;
    dateEnd?: number;
  },
): ViewResult {
  const { query, toolName, limit, offset, includeRemoved, expandTool } = params;
  const roleOpts = {
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.dateStart === undefined ? {} : { dateStart: params.dateStart }),
    ...(params.dateEnd === undefined ? {} : { dateEnd: params.dateEnd }),
  };
  const visibleIds = toolScopeMessageIds(store, toolName, {
    includeRemoved,
    withinMessageIds: params.withinMessageIds,
  });
  let pattern = query;
  const runAll = (text: string, ids: ReadonlySet<number>, removed: boolean) =>
    scopedGrepAll(store, text, { includeRemoved: removed, ...roleOpts, scoped: ids });
  let all: ReturnType<LcmStore["grep"]> | undefined;
  try {
    all = runAll(pattern, visibleIds, includeRemoved);
  } catch {
    all = undefined;
  }
  if (all === undefined) {
    pattern = JSON.stringify(query);
    try {
      all = runAll(pattern, visibleIds, includeRemoved);
    } catch {
      all = undefined;
    }
  }
  if (all === undefined) {
    return {
      ok: false,
      text: `Invalid search query ${JSON.stringify(query)}; try simpler keywords.`,
    };
  }
  const total = all.length;
  const hits = all.slice(offset, offset + limit);
  if (hits.length === 0) {
    if (!includeRemoved) {
      const allIds = toolScopeMessageIds(store, toolName, {
        includeRemoved: true,
        withinMessageIds: params.withinMessageIds,
      });
      let hidden: ReturnType<LcmStore["grep"]> = [];
      try {
        hidden = runAll(pattern, allIds, true);
      } catch {
        hidden = [];
      }
      if (hidden.slice(offset, offset + limit).length > 0) {
        return {
          ok: true,
          text: `Match(es) for ${JSON.stringify(query)} exist on a branch that left the active path; pass include_removed to read them.`,
          details: { hits: 0, removed: hidden.slice(offset, offset + limit).length },
        };
      }
    }
    return {
      ok: true,
      text: `No matches for ${JSON.stringify(query)} in session history.`,
      details: { hits: 0 },
    };
  }
  let budget = RESULT_BUDGET_CHARS;
  const lines: string[] = [
    total <= limit
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
        ? `${flat.slice(0, MAX_LINE_CHARS)} [lcm:more ${dropped} chars; read them with ${expandTool}({entry_id:"${h.entryId}"})]`
        : flat;
    const line = `[${h.entryId}] (${h.role})${pointer}${removed} ${shown}`;
    budget -= line.length;
    lines.push(line);
  }
  const seen = offset + hits.length;
  if (seen < total) {
    lines.push(`… ${total - seen} more; pass offset ${seen} for the next page.`);
  }
  return {
    ok: true,
    text: lines.join("\n"),
    details: { hits: hits.length, offset, total },
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
    expandTool: string;
    role?: GrepFilter["role"];
    dateStart?: number;
    dateEnd?: number;
  },
): ViewResult {
  const compiled = compilePattern(params.pattern, params.caseSensitive);
  if (!compiled.ok) return { ok: false, text: compiled.reason };
  const expandTool = params.expandTool;
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
        ? `${flat.slice(0, MAX_LINE_CHARS)} [lcm:more ${dropped} chars; read them with ${expandTool}({entry_id:"${hit.row.entryId}"})]`
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
    role?: GrepFilter["role"];
    dateStart?: number;
    dateEnd?: number;
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
  const pageOpts = {
    withinMessageIds: params.withinMessageIds,
    includeRemoved: params.includeRemoved,
    ...(params.role === undefined ? {} : { role: params.role }),
    ...(params.dateStart === undefined ? {} : { dateStart: params.dateStart }),
    ...(params.dateEnd === undefined ? {} : { dateEnd: params.dateEnd }),
  };
  for (;;) {
    const page = store.messagePage(cursor, PATTERN_PAGE_ROWS, pageOpts);
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

/** List a summary's messages, or read one as a window. Without a summary an
 * entry id reads directly; with `anchor` and offset 0 the window centers on
 * that entry, clamped at the span edges. A nonzero offset with `anchor` is an
 * absolute message index, so the next page starts from the reported offset. */
export type ExpandParams =
  | {
      mode: "list";
      id: number;
      offset: number;
      limit: number;
      maxChars: number;
      anchor?: string;
    }
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
  const limit = Math.max(0, params.limit);
  let offset = Math.max(0, params.offset);
  let anchorIndex: number | undefined;
  if (params.anchor !== undefined) {
    // Resolve the anchor through the span, not the covered list, so a typo
    // and an entry outside the summary read differently.
    const bounds = store.spanBounds([node.firstEntryId, node.lastEntryId]);
    const spanMessages =
      bounds === null ? [] : store.messagesInSpan(bounds.firstEntryId, bounds.lastEntryId);
    const at = spanMessages.findIndex((m) => m.entryId === params.anchor);
    if (at === -1) return { ok: false, text: `No stored message with entry id ${params.anchor}.` };
    const coveredAt = messages.findIndex((m) => m.entryId === params.anchor);
    if (coveredAt === -1) {
      return {
        ok: false,
        text: `Message ${params.anchor} is not covered by summary #${params.id}.`,
      };
    }
    anchorIndex = coveredAt;
    // With offset 0 the window centers on the anchor; a nonzero offset is an
    // absolute message index so a caller paging from the reported offset moves
    // forward without overlap.
    if (Math.max(0, params.offset) === 0) {
      offset = Math.max(
        0,
        Math.min(coveredAt - Math.floor(limit / 2), Math.max(0, messages.length - limit)),
      );
    } else {
      offset = Math.max(0, params.offset);
    }
  }
  const slice = messages.slice(offset, offset + limit);
  const parts: string[] = [];
  for (const m of slice) {
    parts.push(
      `${messageHeader(m.entryId, m.role)}\n${clippedMessage(m.entryId, redact(readableBody(m)), params.maxChars)}`,
    );
  }
  const hasMore = offset + slice.length < messages.length;
  const listed = `Summary #${params.id} → ${messages.length} original messages (showing ${slice.length} from ${offset})${anchorIndex !== undefined ? ` anchored at ${params.anchor}` : ""}${hasMore ? ", use offset to page" : ""}`;
  return {
    ok: true,
    text: `${listed}\n\n${parts.join("\n\n")}`,
    details: {
      total: messages.length,
      offset,
      ...(anchorIndex === undefined ? {} : { anchor: params.anchor, anchorIndex }),
    },
  };
}

/** Tie-break for display order only, not a ranking model. */
const OVERLAP_STOP_WORDS = new Set(
  "a,an,and,are,as,at,be,but,by,for,from,had,has,have,how,i,in,is,it,its,of,on,or,that,the,their,then,there,these,they,this,to,was,were,what,when,where,which,who,with,you,your".split(
    ",",
  ),
);

function queryWords(query: string): Set<string> {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !OVERLAP_STOP_WORDS.has(w));
  return new Set(words);
}

/** Sort headers the caller already holds, so FTS plus regex stay the recall
 * path and no score is stored. Ties keep input order. */
export function orderSummariesByOverlap<T extends { text: string }>(
  query: string,
  nodes: readonly T[],
): T[] {
  const words = queryWords(query);
  if (words.size === 0) return [...nodes];
  return nodes
    .map((node, index) => {
      const haystack = new Set(node.text.toLowerCase().split(/[^a-z0-9]+/));
      let score = 0;
      for (const w of words) if (haystack.has(w)) score++;
      return { node, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.node);
}

/** At or above this length with no linked file a body reads as `large-inline`,
 * matching the ingest default, so view and writer agree. */
export const LARGE_INLINE_CHARS = 32_000;

/** A read-only files manifest, built at read time, so nothing is stored and
 * no model is called. */
export function filesView(
  store: LcmStore,
  redact: (text: string) => string,
  opts?: { summaryId?: number },
): ViewResult {
  let firstEntryId: string;
  let lastEntryId: string;
  let messageIds: number[];
  if (opts?.summaryId !== undefined) {
    const node = store.getSummary(opts.summaryId);
    if (!node) return { ok: false, text: `No summary with id ${opts.summaryId}.` };
    firstEntryId = node.firstEntryId;
    lastEntryId = node.lastEntryId;
    messageIds = store.coveredMessageIds(node.id);
  } else {
    const span = store.entrySpan();
    if (!span) return { ok: true, text: "No history is stored yet.", details: { files: 0 } };
    firstEntryId = span.first;
    lastEntryId = span.last;
    messageIds = store.allMessages().map((m) => m.id);
  }
  const linked = store.filesForMessages(messageIds);
  const seen = new Map<string, (typeof linked)[number]>();
  for (const f of linked) if (!seen.has(f.fileId)) seen.set(f.fileId, f);
  const files = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const withFiles = new Set(linked.map((f) => f.messageId));
  const uncovered = store.uncoveredMessagesInSpan(firstEntryId, lastEntryId);
  const bodies = store.messagesInSpan(firstEntryId, lastEntryId);
  const largeInline = bodies.filter(
    (m) => m.text.length >= LARGE_INLINE_CHARS && !withFiles.has(m.id),
  );
  const lines = [
    `Files linked in ${firstEntryId} .. ${lastEntryId}: ${files.length} file(s), ${uncovered.length} uncovered message(s).`,
  ];
  for (const f of files) {
    const structure = redact(f.preview.split("\n")[0] ?? "");
    lines.push(`${f.path} (${f.fileId}, ${f.bytes} chars, ${f.kind}; ${structure})`);
  }
  if (uncovered.length > 0) {
    lines.push(
      `[lcm:incomplete-coverage ${uncovered.length} message(s) in this span are covered by no summary]`,
    );
  }
  for (const m of largeInline) {
    lines.push(`[lcm:large-inline ${m.entryId} holds ${m.text.length} chars with no linked file]`);
  }
  if (files.length === 0 && uncovered.length === 0 && largeInline.length === 0) {
    lines.push("No files are linked in this span.");
  }
  return {
    ok: true,
    text: lines.join("\n"),
    details: {
      files: files.length,
      uncovered: uncovered.length,
      largeInline: largeInline.map((m) => m.entryId),
      ...(uncovered.length > 0 ? { incompleteCoverage: true } : {}),
    },
  };
}

export function historyManifest(store: LcmStore, limit: number, query?: string): string {
  const span = store.entrySpan();
  if (!span) return "No history is stored yet.";
  const frontier = store.frontier(span.first, span.last);
  if (frontier.length === 0) {
    return `${store.messageCount()} messages, ${span.first} .. ${span.last}; no summaries yet, so lcm_grep searches the raw messages.`;
  }
  const queryOrdered = query !== undefined && query.trim().length > 0;
  // Frontier reads oldest first; score a newest-first copy so ties and
  // wordless queries keep the newest summaries in a limited manifest.
  const ordered = queryOrdered
    ? orderSummariesByOverlap(query ?? "", [...frontier].reverse()).slice(0, limit)
    : frontier.slice(-limit).reverse();
  const omitted = frontier.length - ordered.length;
  const omittedNote =
    omitted <= 0
      ? ""
      : queryOrdered
        ? ` (${omitted} lower-overlap not listed)`
        : ` (${omitted} older not listed)`;
  return [
    `${frontier.length} top-level summaries cover messages ${span.first} .. ${span.last}${omittedNote}:`,
    ...ordered.map((n) => costLine(store, n)),
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
