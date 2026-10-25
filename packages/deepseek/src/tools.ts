import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_RETRIEVAL_TOKENS,
  NO_STORE,
  RECALL_SCOPES,
  RETRIEVAL_STEPS,
  billedCounters,
  describeAnswer as coreDescribeAnswer,
  expandAnswer as coreExpandAnswer,
  grepView,
  runRetrieval,
  LcmStore,
  type Reader,
  type RecallToolDeps as CoreRecallDeps,
  type RetrievalScope,
  type SidecarRef,
} from "lossless-core";

import type { DshRoute } from "./model-host.ts";
import { agentRoute, dshRef } from "./model-host.ts";
import { dshReader } from "./reader.ts";

export interface PastSessions {
  /** Sidecars past sessions are read from, newest first. The listing
   * excludes the calling session, so no scope can reach the store a
   * normal grep already searched. Backed by `SidecarStores.list`, which
   * reads the directory rather than the open cache, so sessions from
   * earlier processes are reachable. */
  readonly list: (excludeSessionId?: string) => readonly SidecarRef[];
}

export interface RecallDeps {
  /** Sidecar by calling-agent session. Undefined answers the no-history
   * text, so a call outside any agent fails explained rather than empty. */
  readonly store: (sessionId: string | undefined) => LcmStore | undefined;
  readonly redact: (text: string) => string;
  /** Diagnostic sink for retrieval rows. Optional, so a test can observe
   * retrieval without a metrics file; production passes the per-composition
   * JSONL writer. */
  readonly record?: (row: Record<string, unknown>) => void;
  /** The sidecars a cross-session scope scans. Absent answers explained. */
  readonly pastSessions?: PastSessions;
}

/** Caps for one cross-session scan, matching the Pi precedent
 * (`SESSION_SCAN_LIMIT`, `SESSION_HITS_LIMIT`,
 * `SESSION_SEARCH_DEADLINE_MS`): an unbounded directory read inside a
 * tool call is a latency bug, so whichever cap stops the scan is named in
 * the answer. OpenCode carries the same numbers. */
export const CROSS_SESSION_STORE_LIMIT = 20;
export const CROSS_SESSION_HITS_LIMIT = 40;
export const CROSS_SESSION_DEADLINE_MS = 1_500;
/** Hits one past session may contribute. A single chatty store must not
 * fill the whole page while newer stores go unread. */
export const CROSS_SESSION_PER_STORE_HITS = 10;

/** Register the three recall tools on a composition with a tools service.
 * Returns one disposer for all three. The descriptions match the loop tools
 * core hands the reader, so both seams present the same surface. */
export function registerRecallTools(ctx: Context, deps: RecallDeps): () => void {
  const stop = [
    ctx.tools.register(lcmGrepTool(deps)),
    ctx.tools.register(lcmDescribeTool(deps)),
    ctx.tools.register(lcmExpandTool(deps)),
  ];
  return () => {
    for (const dispose of stop) dispose();
  };
}

/** Register the fourth recall tool, the answered reader over `runRetrieval`.
 * Separate from the three direct tools because it needs the composition
 * context to run the reader. Returns its disposer. */
export function registerExpandQueryTool(ctx: Context, deps: RecallDeps): () => void {
  const dispose = ctx.tools.register(lcmExpandQueryTool(ctx, deps));
  return () => dispose();
}

function toCoreDeps(deps: RecallDeps): CoreRecallDeps {
  if (!deps.pastSessions) {
    return {
      storeFor: (sessionId) => deps.store(sessionId === "" ? undefined : sessionId),
      redact: deps.redact,
      ...(deps.record === undefined ? {} : { record: deps.record }),
    };
  }
  const past = deps.pastSessions;
  const redact = deps.redact;
  return {
    storeFor: (sessionId) => deps.store(sessionId === "" ? undefined : sessionId),
    redact,
    ...(deps.record === undefined ? {} : { record: deps.record }),
    searchPast: (session, query, scope, limit, filters) => {
      const result = searchPastSessions({ past, redact }, session, query, {
        ...(typeof limit === "number" ? { limit } : {}),
        ...(filters?.role === undefined ? {} : { role: filters.role }),
        ...(filters?.dateStart === undefined ? {} : { dateStart: filters.dateStart }),
        ...(filters?.dateEnd === undefined ? {} : { dateEnd: filters.dateEnd }),
        ...(filters?.toolName === undefined ? {} : { toolName: filters.toolName }),
      });
      return {
        text: result.text,
        hits: result.hits,
        scanned: result.scanned,
        skipped: result.skipped,
      };
    },
    openPast: (session, pastSession) => {
      const opened = openPastSession(past, session, pastSession);
      if (opened.kind !== "opened") return opened;
      return { kind: "opened" as const, sessionId: opened.ref.id, store: opened.store };
    },
  };
}

/** Past-search outcome for the recorder: redacted text plus hit, scanned,
 * and skipped session counts. */
export interface PastSearchResult {
  readonly text: string;
  readonly hits: number;
  readonly scanned: number;
  readonly skipped: number;
}

export type PastSearchStop = "stores" | "hits" | "deadline";

export interface PastSearchDeps {
  readonly past: PastSessions;
  readonly redact: (text: string) => string;
  readonly now?: () => number;
}

/** Search every past sidecar for `query` and format the labelled hits. A
 * store that cannot be opened is counted and skipped: an older generation
 * or a file in use is not an error the caller can act on mid-turn. The
 * past store opens with `queryOnly` so a scan can never rewrite a session
 * it is only reading. */
export function searchPastSessions(
  deps: PastSearchDeps,
  callingSessionId: string | undefined,
  query: string,
  opts: {
    limit?: number;
    now?: () => number;
    role?: "user" | "assistant" | "toolResult" | "custom";
    dateStart?: number;
    dateEnd?: number;
    toolName?: string;
  } = {},
): PastSearchResult & { stoppedBy?: PastSearchStop; elapsedMs: number } {
  const now = opts.now ?? deps.now ?? Date.now;
  const started = now();
  const hitLimit = clampLimit(opts.limit, CROSS_SESSION_HITS_LIMIT);
  const deadline = started + CROSS_SESSION_DEADLINE_MS;
  const all = deps.past.list(callingSessionId);
  const refs = all.slice(0, CROSS_SESSION_STORE_LIMIT);

  const lines: string[] = [];
  const sessions = new Set<string>();
  let hits = 0;
  let scanned = 0;
  let skipped = 0;
  let stoppedBy: PastSearchStop | undefined = all.length > refs.length ? "stores" : undefined;

  for (const ref of refs) {
    if (hits >= hitLimit) {
      stoppedBy = "hits";
      break;
    }
    if (now() > deadline) {
      stoppedBy = "deadline";
      break;
    }
    let store: LcmStore | undefined;
    try {
      store = new LcmStore(ref.path, { queryOnly: true });
    } catch {
      skipped++;
      continue;
    }
    try {
      const view = grepView(store, deps.redact, {
        query,
        limit: Math.min(CROSS_SESSION_PER_STORE_HITS, hitLimit - hits),
        ...(opts.role === undefined ? {} : { role: opts.role }),
        ...(opts.dateStart === undefined ? {} : { dateStart: opts.dateStart }),
        ...(opts.dateEnd === undefined ? {} : { dateEnd: opts.dateEnd }),
        ...(opts.toolName === undefined ? {} : { toolName: opts.toolName }),
        expandTool: "lcm_expand",
      });
      if (!view.ok) {
        // A query this store rejects was rejected by every store; report the
        // view's own message rather than a fake "no matches".
        skipped++;
        return finishPastSearch(view.text, {
          hits: 0,
          scanned,
          skipped,
          sessions: 0,
          started,
          now,
          stoppedBy,
        });
      }
      scanned++;
      for (const line of view.text.split("\n")) {
        if (!line.startsWith("[")) continue;
        if (hits >= hitLimit) break;
        lines.push(`[lcm:session ${ref.id}] ${line}`);
        hits++;
        sessions.add(ref.id);
      }
    } catch {
      skipped++;
    } finally {
      store.close();
    }
  }

  if (hits >= hitLimit && stoppedBy === undefined) stoppedBy = "hits";
  const skippedNote = skipped === 0 ? "" : `, skipped ${skipped} unreadable`;
  const body =
    hits === 0
      ? `No matches in ${scanned} past session(s)${skippedNote}.`
      : [
          `Found ${hits} match(es) across ${sessions.size} past session(s) in ${now() - started} ms (scanned ${scanned}${skippedNote}).`,
          ...lines,
          "Read a hit with lcm_expand({session, entry_id}); the text it returns is that past session's history, never this one's.",
        ].join("\n");
  const stopped = stoppedBy === undefined ? undefined : stopNote(stoppedBy, hitLimit);
  return finishPastSearch(stopped === undefined ? body : `${body}\n${stopped}`, {
    hits,
    scanned,
    skipped,
    sessions: sessions.size,
    started,
    now,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  });
}

/** The cap that ended the scan, named so a short answer is not read as a
 * complete one. */
export function stopNote(
  stoppedBy: PastSearchStop | undefined,
  hitLimit: number = CROSS_SESSION_HITS_LIMIT,
): string | undefined {
  switch (stoppedBy) {
    case "stores":
      return `Stopped at the ${CROSS_SESSION_STORE_LIMIT}-store cap; older sessions were not searched.`;
    case "hits":
      return `Stopped at the ${hitLimit}-hit cap; narrow the query or read one session.`;
    case "deadline":
      return `Stopped at the ${CROSS_SESSION_DEADLINE_MS} ms deadline; narrow the query.`;
    default:
      return undefined;
  }
}

/** The past sidecar a caller named, or why it cannot be read. The id is
 * looked up in the listing rather than joined into a path, so a hostile id
 * cannot escape the sidecar directory. */
export function openPastSession(
  past: PastSessions,
  callingSessionId: string | undefined,
  sessionId: string,
): { kind: "opened"; ref: SidecarRef; store: LcmStore } | { kind: "missing" | "unreadable" } {
  const ref = past.list(callingSessionId).find((candidate) => candidate.id === sessionId);
  if (ref === undefined) return { kind: "missing" };
  try {
    return { kind: "opened", ref, store: new LcmStore(ref.path, { queryOnly: true }) };
  } catch {
    return { kind: "unreadable" };
  }
}

function finishPastSearch(
  text: string,
  state: {
    hits: number;
    scanned: number;
    skipped: number;
    sessions: number;
    started: number;
    now: () => number;
    stoppedBy?: PastSearchStop;
  },
): PastSearchResult & { stoppedBy?: PastSearchStop; elapsedMs: number } {
  return {
    text,
    hits: state.hits,
    scanned: state.scanned,
    skipped: state.skipped,
    elapsedMs: state.now() - state.started,
    ...(state.stoppedBy === undefined ? {} : { stoppedBy: state.stoppedBy }),
  };
}

function clampLimit(raw: number | undefined, max: number): number {
  const value = raw !== undefined && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : max;
  return Math.min(max, Math.max(1, value));
}

// SQLite returns no rows for LIMIT 0 and every row for a negative LIMIT.
function clampSessionLimit(raw: number): number | undefined {
  return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : undefined;
}

export interface GrepArgs {
  readonly query?: string;
  readonly pattern?: string;
  readonly case_sensitive?: boolean;
  readonly offset?: number;
  readonly after?: string;
  readonly limit?: number;
  readonly summary_id?: number;
  readonly include_removed?: boolean;
  readonly role?: "user" | "assistant" | "toolResult" | "custom";
  readonly date_start?: number;
  readonly date_end?: number;
  readonly tool_name?: string;
  readonly scope?: string;
}

export interface GrepTestOptions {
  readonly pastSessions?: PastSessions;
  readonly sessionId?: string;
  readonly record?: (row: Record<string, unknown>) => void;
}

/** Session-less answer for tests: binds one store through the single
 * converter above with the empty session id. Query plus limit behave
 * exactly as before; the extra params map one to one onto `grepView`,
 * which already honors every one of them (verified against
 * `packages/core/src/recall-view.ts`: query, pattern, caseSensitive,
 * offset, after, limit, summaryId, includeRemoved). `scope` defaults to
 * the calling session, so existing callers see no behavior change. */
export function grepAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: GrepArgs,
  opts: GrepTestOptions = {},
): string {
  const deps: RecallDeps = {
    store: () => store,
    redact,
    ...(opts.record === undefined ? {} : { record: opts.record }),
    ...(opts.pastSessions === undefined ? {} : { pastSessions: opts.pastSessions }),
  };
  return answerGrep(deps, opts.sessionId ?? "", args);
}

/** Session grep plus past-session search behind `lcm_grep`, mirroring Pi
 * params and caps: this session reads `grepView` directly with every
 * named param, while `sessions` and `all_sessions` scan the sidecar
 * directory (equivalent here because it is global, as in OpenCode) with a
 * 20-store, 40-hit, 1.5 s cap and record sessionsScanned/Skipped. A
 * pattern scan stays session-scoped, as in Pi. */
export function answerGrep(deps: RecallDeps, callerSessionId: string, args: GrepArgs): string {
  const started = Date.now();
  const session = callerSessionId;
  const rawScope = args.scope;
  const scope = rawScope === undefined ? "session" : asRecallScope(rawScope);
  const query = args.query;
  const queryChars = query?.length ?? 0;
  if (scope === undefined) {
    recordGrep(deps, session, {
      tool: "lcm_grep",
      outcome: "refused",
      queryChars,
      durationMs: Date.now() - started,
      ...(typeof rawScope === "string" ? { scope: rawScope } : {}),
    });
    return "lcm_grep scope must be session, sessions, or all_sessions.";
  }
  if (scope !== "session") {
    if (args.pattern !== undefined) {
      recordGrep(deps, session, {
        tool: "lcm_grep",
        outcome: "refused",
        queryChars,
        scope,
        durationMs: Date.now() - started,
      });
      return "LCM: a pattern scan searches this session. Pass query for past sessions.";
    }
    if (query === undefined) {
      recordGrep(deps, session, {
        tool: "lcm_grep",
        outcome: "error",
        queryChars,
        scope,
        durationMs: Date.now() - started,
      });
      return "LCM: pass a query to search past sessions.";
    }
    if (!deps.pastSessions) {
      recordGrep(deps, session, {
        tool: "lcm_grep",
        outcome: "refused",
        queryChars,
        scope,
        durationMs: Date.now() - started,
      });
      return "LCM: past sessions are not reachable in this process (no sidecar directory is wired).";
    }
    const result = searchPastSessions(
      { past: deps.pastSessions, redact: deps.redact },
      session,
      query,
      {
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.date_start === undefined ? {} : { dateStart: args.date_start }),
        ...(args.date_end === undefined ? {} : { dateEnd: args.date_end }),
        ...(args.tool_name === undefined ? {} : { toolName: args.tool_name }),
      },
    );
    recordGrep(deps, session, {
      tool: "lcm_grep",
      outcome: result.hits === 0 ? "miss" : "hit",
      hits: result.hits,
      queryChars,
      scope,
      sessionsScanned: result.scanned,
      sessionsSkipped: result.skipped,
      durationMs: Date.now() - started,
    });
    return result.text;
  }
  if (query === undefined && args.pattern === undefined) {
    recordGrep(deps, session, {
      tool: "lcm_grep",
      outcome: "error",
      queryChars,
      durationMs: Date.now() - started,
    });
    return "lcm_grep needs a query string.";
  }
  const store = deps.store(callerSessionId === "" ? undefined : callerSessionId);
  if (!store) {
    recordGrep(deps, session, {
      tool: "lcm_grep",
      outcome: "miss",
      hits: 0,
      queryChars,
      durationMs: Date.now() - started,
    });
    return NO_STORE;
  }
  const sessionLimit = typeof args.limit === "number" ? clampSessionLimit(args.limit) : undefined;
  const view = grepView(store, deps.redact, {
    ...(query === undefined ? {} : { query }),
    ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
    ...(args.case_sensitive === undefined ? {} : { caseSensitive: args.case_sensitive }),
    ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
    ...(args.after === undefined ? {} : { after: args.after }),
    ...(sessionLimit === undefined ? {} : { limit: sessionLimit }),
    ...(typeof args.summary_id === "number" ? { summaryId: args.summary_id } : {}),
    ...(args.include_removed === undefined ? {} : { includeRemoved: args.include_removed }),
    ...(args.role === undefined ? {} : { role: args.role }),
    ...(args.date_start === undefined ? {} : { dateStart: args.date_start }),
    ...(args.date_end === undefined ? {} : { dateEnd: args.date_end }),
    ...(args.tool_name === undefined ? {} : { toolName: args.tool_name }),
    expandTool: "lcm_expand",
  });
  const hits = view.ok && typeof view.details.hits === "number" ? view.details.hits : 0;
  recordGrep(deps, session, {
    tool: "lcm_grep",
    outcome: !view.ok ? "error" : hits === 0 ? "miss" : "hit",
    hits,
    queryChars,
    durationMs: Date.now() - started,
  });
  return view.text;
}

function asRecallScope(raw: unknown): (typeof RECALL_SCOPES)[number] | undefined {
  return typeof raw === "string" && (RECALL_SCOPES as readonly string[]).includes(raw)
    ? (raw as (typeof RECALL_SCOPES)[number])
    : undefined;
}

function recordGrep(
  deps: Pick<RecallDeps, "record">,
  session: string,
  row: Record<string, unknown>,
): void {
  deps.record?.({ ts: Date.now(), session, kind: "recall", ...row });
}

/** Session-less answer for tests: see grepAnswer. */
export function describeAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: { id: number },
): string {
  return coreDescribeAnswer(toCoreDeps({ store: () => store, redact }), "", args);
}

export interface ExpandArgs {
  readonly id?: number;
  readonly entry_id?: string;
  readonly anchor?: string;
  readonly session?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly char_offset?: number;
  readonly max_chars?: number;
}

/** Session-less answer for tests: see grepAnswer. The `session` param
 * resolves through the same sidecar lookup the tool uses; without wired
 * past sessions a foreign session falls back to the bound store so
 * single-store tests keep working. */
export function expandAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: ExpandArgs,
  opts: GrepTestOptions = {},
): string {
  const deps: RecallDeps = {
    store: () => store,
    redact,
    ...(opts.record === undefined ? {} : { record: opts.record }),
    ...(opts.pastSessions === undefined ? {} : { pastSessions: opts.pastSessions }),
  };
  return coreExpandAnswer(toCoreDeps(deps), opts.sessionId ?? "", args);
}

export interface ExpandQueryArgs {
  readonly query: string;
  readonly prompt?: string;
  readonly summary_id?: number;
  readonly entry_id?: string;
  readonly session?: string;
  readonly max_tokens?: number;
}

/** Session-less answered retrieval for tests: binds one store and one reader
 * through the same converter the tool uses, with the same record seam. */
export function expandQueryAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  reader: Reader,
  sessionId: string | undefined,
  args: ExpandQueryArgs,
  record?: (row: Record<string, unknown>) => void,
  pastSessions?: PastSessions,
): Promise<string> {
  const deps: RecallDeps = {
    store: () => store,
    redact,
    ...(record === undefined ? {} : { record }),
    ...(pastSessions === undefined ? {} : { pastSessions }),
  };
  return answerExpandQuery(toCoreDeps(deps), reader, sessionId, args);
}

const DEFAULT_EXPAND_QUERY_PROMPT =
  "Answer the question from the stored history, citing the entry or summary ids relied on.";

/** Answered retrieval behind `lcm_expand_query`: the `session` param names
 * another session kept in this process, resolved read-only through the
 * sidecar listing when it names a past session (closed after the run, so
 * a ghost id creates no file), and every run that reaches past validation
 * emits one retrieval-kind row when a recorder is present. A past
 * session's answer is labelled as such, mirroring Pi, and findings stay
 * wrapped so the raw transcript never enters the caller's context. */
async function answerExpandQuery(
  deps: CoreRecallDeps,
  reader: Reader,
  sessionId: string | undefined,
  args: ExpandQueryArgs,
): Promise<string> {
  const budgetTokens = args.max_tokens ?? DEFAULT_RETRIEVAL_TOKENS;
  const scope = expandScope(args);
  if (typeof scope === "string") {
    recordRetrieval(deps, sessionId, {
      queryChars: args.query.length,
      budgetTokens,
      steps: 0,
      retrievedTokens: 0,
      stop: "refused",
      reason: scope,
    });
    return `Nothing was read: ${scope}.`;
  }
  if (args.session !== undefined && args.session.trim() === "") {
    recordRetrieval(deps, sessionId, {
      queryChars: args.query.length,
      budgetTokens,
      steps: 0,
      retrievedTokens: 0,
      stop: "refused",
      reason: "session must be a non-empty session id",
    });
    return "Nothing was read: session must be a non-empty session id.";
  }
  const caller = sessionId ?? "";
  const pastId = args.session === undefined || args.session === caller ? undefined : args.session;
  let target: LcmStore | undefined;
  let pastSession: string | undefined;
  let closePast = false;
  if (pastId === undefined) {
    target = deps.storeFor(sessionId ?? "");
  } else if (deps.openPast !== undefined && sessionId !== undefined) {
    const opened = deps.openPast(sessionId, pastId);
    if (opened.kind !== "opened") {
      recordRetrieval(deps, sessionId, {
        queryChars: args.query.length,
        budgetTokens,
        steps: 0,
        retrievedTokens: 0,
        stop: "refused",
        reason:
          opened.kind === "missing"
            ? `no stored session with id ${pastId}`
            : `session ${pastId} could not be opened (an older generation, or in use)`,
      });
      return opened.kind === "missing"
        ? `Nothing was read: no stored session with id ${pastId}.`
        : `Nothing was read: session ${pastId} could not be opened (an older generation, or in use).`;
    }
    target = opened.store;
    pastSession = opened.sessionId;
    closePast = true;
  } else {
    target = deps.storeFor(pastId);
  }
  if (!target) {
    recordRetrieval(deps, sessionId, {
      queryChars: args.query.length,
      budgetTokens,
      steps: 0,
      retrievedTokens: 0,
      stop: "refused",
      reason: "no stored history for this session yet",
    });
    return NO_STORE;
  }
  let run: Awaited<ReturnType<typeof runRetrieval>>;
  try {
    run = await runRetrieval(
      target,
      {
        query: args.query,
        prompt:
          args.prompt !== undefined && args.prompt.length > 0
            ? args.prompt
            : DEFAULT_EXPAND_QUERY_PROMPT,
        budgetTokens,
        maxSteps: RETRIEVAL_STEPS,
        redact: deps.redact,
        ...(scope === undefined ? {} : { scope }),
      },
      reader,
    );
  } finally {
    if (closePast) target.close();
  }
  recordRetrieval(deps, sessionId, {
    queryChars: args.query.length,
    budgetTokens,
    steps: run.steps,
    retrievedTokens: run.retrievedTokens,
    stop: run.kind,
    ...(run.kind === "answered" ? {} : { reason: run.reason }),
    ...(scope === undefined ? {} : { scope: scope.kind }),
    ...(scope?.kind === "summary" ? { summaryId: scope.summaryId } : {}),
    ...(scope?.kind === "entry" ? { entryId: scope.entryId } : {}),
    ...billedCounters(run.usage),
  });
  if (run.kind === "refused") {
    return `Nothing was read: ${run.reason}.`;
  }
  if (run.kind === "failed") {
    return `Retrieval failed: ${run.reason}`;
  }
  if (run.kind === "stopped" && run.text.length === 0) {
    return (
      `Retrieval stopped (${run.reason}) after ${run.steps} step(s) without an answer; ` +
      `narrow the query or raise max_tokens.`
    );
  }
  const stopped = run.kind === "stopped" ? `, stopped: ${run.reason}` : "";
  const where =
    pastSession === undefined
      ? "stored history"
      : `a past session's history (session ${pastSession})`;
  const header =
    `Read ${where} in ${run.steps} step(s) ` +
    `(${run.retrievedTokens} of ${budgetTokens} tokens)${stopped}.`;
  const tag =
    pastSession === undefined
      ? "recovered_findings"
      : `recovered_findings session="${pastSession}"`;
  return `${header}\n<${tag}>\n${run.text}\n</recovered_findings>`;
}

function expandScope(args: {
  summary_id?: number;
  entry_id?: string;
}): RetrievalScope | string | undefined {
  if (args.summary_id !== undefined && args.entry_id !== undefined) {
    return "pass summary_id or entry_id, not both";
  }
  if (args.summary_id !== undefined) return { kind: "summary", summaryId: args.summary_id };
  if (args.entry_id === undefined) return undefined;
  if (args.entry_id.length === 0) return "entry_id is empty";
  return { kind: "entry", entryId: args.entry_id };
}

function recordRetrieval(
  deps: CoreRecallDeps,
  sessionId: string | undefined,
  row: Record<string, unknown>,
): void {
  deps.record?.({
    event: "lcm",
    kind: "retrieval",
    ...(sessionId === undefined ? {} : { session: sessionId }),
    ...row,
  });
}

/** The reader calls the calling agent's model: the latest routed request
 * first, agent options second, mirroring the ladder's fallback order. */
function readerRoute(agent: Agent | undefined): DshRoute | undefined {
  // One route contract; the guards live in model-host.
  return agentRoute(agent);
}

function sessionOf(exec: ToolRunContext): string | undefined {
  const id = exec.agent?.session.id;
  return id === undefined ? undefined : String(id);
}

function lcmGrepTool(deps: RecallDeps) {
  return defineTool({
    name: "lcm_grep",
    description:
      "Full-text search over the stored session history. Each hit names the summary (#N) that covers it, which lcm_expand reads. Pass `query` for a full-text search, or `pattern` for a JavaScript regular expression over the full text of every message. `scope` widens the search to past sessions in this sidecar directory; sessions and all_sessions are equivalent here because the directory is global.",
    parameters: {
      query: {
        type: "string",
        description: "FTS5 query: quoted phrases, AND/OR, prefix*",
      },
      pattern: {
        type: "string",
        description:
          "JavaScript regular expression over the full text of every stored message. Case-insensitive unless case_sensitive is set. Give one of query or pattern, not both.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Match a pattern with its own case (default false)",
      },
      offset: { type: "integer", description: "Hits to skip, for the next page" },
      after: {
        type: "string",
        description:
          "Continue a pattern scan from this entry id, which is the `after` value a deadline stop names",
      },
      limit: { type: "integer", description: "Hits to return" },
      summary_id: {
        type: "integer",
        description: "Restrict hits to the messages this summary covers",
      },
      include_removed: {
        type: "boolean",
        description:
          "Include matches from a branch that left the active path (excluded by default)",
      },
      role: {
        type: "string",
        enum: ["user", "assistant", "toolResult", "custom"],
        description: "Keep only rows stored with this role",
      },
      date_start: {
        type: "number",
        description: "Keep only rows at or after this timestamp",
      },
      date_end: {
        type: "number",
        description: "Keep only rows at or before this timestamp",
      },
      tool_name: {
        type: "string",
        description:
          "Keep only tool-result rows for this tool. It matches [tool:Name] markers. It applies to query searches only.",
      },
      scope: {
        type: "string",
        enum: [...RECALL_SCOPES],
        description:
          "session (default) searches this session. sessions and all_sessions search past sessions in this sidecar directory and are equivalent here.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return answerGrep(deps, sessionOf(exec) ?? "", args);
    },
  });
}

function lcmDescribeTool(deps: RecallDeps) {
  return defineTool({
    name: "lcm_describe",
    description:
      "Inspect a summary without expanding it: kind, depth, own and source token costs, children with their costs, parents, and full text.",
    parameters: {
      id: {
        type: "integer",
        required: true,
        description: "Summary id, the N in [lcm:summary #N ...]",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return coreDescribeAnswer(toCoreDeps(deps), sessionOf(exec) ?? "", args);
    },
  });
}

function lcmExpandTool(deps: RecallDeps) {
  return defineTool({
    name: "lcm_expand",
    description:
      "Read the original messages a summary covers, or one named entry. Without entry_id, list `limit` messages from message index `offset`, or centered on `anchor` when it names an entry id. With entry_id, read that one message from `char_offset` for up to `max_chars` characters; continue from the char_offset the result reports. `id` is the summary to list, or to check that the entry is covered; omit it to read an entry that no summary covers yet. Pass `session` with the id from an [lcm:session <id>] hit to read that past session's sidecar; the text is labelled as a past session's history and the read is read-only.",
    parameters: {
      id: { type: "integer", description: "Summary id, the N in [lcm:summary #N ...]" },
      entry_id: { type: "string", description: "Read this one message by entry id" },
      anchor: {
        type: "string",
        description: "Center the listing window on this entry id (with id, without entry_id)",
      },
      session: {
        type: "string",
        description:
          "The past session id from an [lcm:session <id>] hit. Its sidecar is read read-only and the text is labelled as a past session's history.",
      },
      offset: { type: "integer", description: "Message index to start listing from" },
      limit: { type: "integer", description: "Messages to list" },
      char_offset: { type: "integer", description: "Character offset inside entry_id" },
      max_chars: { type: "integer", description: "Characters to read from entry_id" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return coreExpandAnswer(toCoreDeps(deps), sessionOf(exec) ?? "", args);
    },
  });
}

function lcmExpandQueryTool(ctx: Context, deps: RecallDeps) {
  return defineTool({
    name: "lcm_expand_query",
    description:
      "Recover content from compacted history and answer a question about it. Use it whenever lcm_grep or a summary in context points at what you need but you do not have its text. Pass summary_id to read one summary's originals, or entry_id to read one stored message; without either it searches. A bounded reader expands the stored originals and returns findings only, so the raw transcript never enters this context. Ask for verbatim quotes in `prompt` when the exact words matter.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "What to search for in the stored history",
      },
      prompt: {
        type: "string",
        description:
          "What to find out, and the form the answer should take (ask for a verbatim quote when the exact words matter)",
      },
      summary_id: {
        type: "integer",
        description: "Read this summary's originals: the N from an [lcm:summary #N ...] header",
      },
      entry_id: {
        type: "string",
        description: "Read this one stored message: the entry id a grep hit names",
      },
      session: {
        type: "string",
        description:
          "Read another session kept in this process instead of the calling one; names a session id, never a file.",
      },
      max_tokens: {
        type: "integer",
        description: `Retrieved content budget in estimated tokens (default ${DEFAULT_RETRIEVAL_TOKENS})`,
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec);
      const coreDeps = toCoreDeps(deps);
      const route = readerRoute(exec.agent);
      if (route === undefined) {
        recordRetrieval(coreDeps, sessionId, {
          queryChars: args.query.length,
          budgetTokens: args.max_tokens ?? DEFAULT_RETRIEVAL_TOKENS,
          steps: 0,
          retrievedTokens: 0,
          stop: "failed",
          reason: "no provider/model available for the reader",
        });
        return "lossless retrieval: no provider/model available for the reader: route one request or set both agent options fields.";
      }
      return answerExpandQuery(
        coreDeps,
        dshReader(ctx, {
          ref: dshRef(route),
          signal: exec.signal,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
        sessionId,
        args,
      );
    },
  });
}
