import { describeView, expandView, grepView } from "../recall-view.ts";
import { MAX_EXPAND_CHARS } from "../retrieval.ts";
import type { LcmStore } from "../store.ts";

/** Reply when the caller has no store: nothing ingested yet, or the session is ephemeral. */
export const NO_STORE =
  "LCM: no stored history for this session yet (nothing has been ingested, or the session is ephemeral).";

/** Search scopes `lcm_grep` accepts: this session only, plus the past-session scopes. */
export const RECALL_SCOPES = ["session", "sessions", "all_sessions"] as const;
/** One of `RECALL_SCOPES`; `sessions` and `all_sessions` are equivalent and both read past sidecars. */
export type RecallScope = (typeof RECALL_SCOPES)[number];

/** What `lcm_expand` reads: a summary listing by id, or one message by entry id with an optional summary check. */
export type Address =
  | { readonly kind: "summary"; readonly id: number }
  | { readonly kind: "entry"; readonly entryId: string; readonly id?: number };

/** Past-search outcome: redacted text plus hit, scanned, and skipped session counts. */
export interface RecallPastSearchResult {
  readonly text: string;
  readonly hits: number;
  readonly scanned: number;
  readonly skipped: number;
}

/** Past-session open outcome: the read-only store and id, or why it could not be opened. */
export type OpenPastResult =
  | {
      readonly kind: "opened";
      readonly sessionId: string;
      readonly store: LcmStore;
    }
  | { readonly kind: "missing" | "unreadable" };

/** Host seams the recall answers read through: store lookup, redactor, metrics recorder, and past-session hooks. */
export interface RecallToolDeps {
  readonly storeFor: (sessionId: string | undefined) => LcmStore | undefined;
  readonly redact: (text: string) => string;
  readonly record?: (row: Record<string, unknown>) => void;
  readonly sessionOf?: (sessionId: string) => string;
  readonly isReader?: (sessionId: string) => boolean;
  readonly searchPast?: (
    session: string,
    query: string,
    scope: Exclude<RecallScope, "session">,
    limit: unknown,
  ) => RecallPastSearchResult;
  readonly openPast?: (session: string, pastSession: string) => OpenPastResult;
  readonly pastSearchUnreachableText?: string;
  readonly pastReadUnreachableText?: string;
}

const DEFAULT_PAST_SEARCH_UNREACHABLE =
  "LCM: past sessions are not reachable in this process (no sidecar directory is wired).";
const DEFAULT_PAST_READ_UNREACHABLE =
  "Nothing was read: past sessions are not reachable in this process.";

/** Answer `lcm_grep`: the session `grepView`, or past sidecars when the scope names them; readers stay session-scoped. */
export function grepAnswer(deps: RecallToolDeps, callerSessionID: string, input: unknown): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, callerSessionID);
  const rawScope = args.scope;
  const scope = rawScope === undefined ? "session" : asScope(rawScope);
  const query = typeof args.query === "string" ? args.query : undefined;
  const queryChars = query?.length ?? 0;
  if (scope === undefined) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "refused",
      queryChars,
      durationMs: Date.now() - started,
      ...(typeof rawScope === "string" ? { scope: rawScope } : {}),
    });
    return "lcm_grep scope must be session, sessions, or all_sessions.";
  }
  if (query === undefined) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "error",
      queryChars,
      durationMs: Date.now() - started,
      ...(scope === "session" ? {} : { scope }),
    });
    return "lcm_grep needs a query string.";
  }
  if (scope !== "session" && deps.isReader?.(callerSessionID) === true) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "refused",
      queryChars,
      scope,
      durationMs: Date.now() - started,
    });
    return "LCM: the reader is session-scoped, so it cannot search past sessions.";
  }
  if (scope !== "session") {
    return grepPastSessions(deps, session, query, scope, started, args.limit);
  }
  const store = deps.storeFor(callerSessionID);
  if (!store) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "miss",
      hits: 0,
      queryChars,
      durationMs: Date.now() - started,
    });
    return NO_STORE;
  }
  const view = grepView(store, deps.redact, {
    query,
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    expandTool: "lcm_expand",
  });
  const hits = view.ok && typeof view.details.hits === "number" ? view.details.hits : 0;
  recordRecall(deps, session, {
    tool: "lcm_grep",
    outcome: !view.ok ? "error" : hits === 0 ? "miss" : "hit",
    hits,
    queryChars,
    durationMs: Date.now() - started,
  });
  return view.text;
}

function grepPastSessions(
  deps: RecallToolDeps,
  session: string,
  query: string,
  scope: Exclude<RecallScope, "session">,
  started: number,
  limit: unknown,
): string {
  if (!deps.searchPast) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "refused",
      queryChars: query.length,
      scope,
      durationMs: Date.now() - started,
    });
    return deps.pastSearchUnreachableText ?? DEFAULT_PAST_SEARCH_UNREACHABLE;
  }
  const result = deps.searchPast(session, query, scope, limit);
  recordRecall(deps, session, {
    tool: "lcm_grep",
    outcome: result.hits === 0 ? "miss" : "hit",
    hits: result.hits,
    queryChars: query.length,
    scope,
    sessionsScanned: result.scanned,
    sessionsSkipped: result.skipped,
    durationMs: Date.now() - started,
  });
  return result.text;
}

/** Answer `lcm_describe`: the redacted cost and contents of one summary id, or why it missed. */
export function describeAnswer(
  deps: RecallToolDeps,
  callerSessionID: string,
  input: unknown,
): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, callerSessionID);
  const store = deps.storeFor(callerSessionID);
  if (!store) {
    recordRecall(deps, session, {
      tool: "lcm_describe",
      outcome: "miss",
      durationMs: Date.now() - started,
    });
    return NO_STORE;
  }
  if (typeof args.id !== "number") {
    recordRecall(deps, session, {
      tool: "lcm_describe",
      outcome: "error",
      durationMs: Date.now() - started,
    });
    return "lcm_describe needs a summary id.";
  }
  const view = describeView(store, deps.redact, args.id);
  recordRecall(deps, session, {
    tool: "lcm_describe",
    outcome: view.ok ? "hit" : "miss",
    summaryId: args.id,
    durationMs: Date.now() - started,
  });
  return view.text;
}

/** Answer `lcm_expand`: list a summary or read one message, capped at `MAX_EXPAND_CHARS`; a foreign `session` id reads a past sidecar read-only. */
export function expandAnswer(
  deps: RecallToolDeps,
  callerSessionID: string,
  input: unknown,
): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, callerSessionID);
  const maxChars = Math.min(
    typeof args.max_chars === "number" ? args.max_chars : MAX_EXPAND_CHARS,
    MAX_EXPAND_CHARS,
  );
  const address = readAddress(args);
  if (typeof address === "string") {
    recordExpand(deps, session, "error", started, args);
    return address;
  }
  if (address === undefined) {
    recordExpand(deps, session, "error", started, args);
    return "lcm_expand needs an id (a summary to list) or an entry_id.";
  }
  const rawSession = args.session;
  if (rawSession !== undefined && (typeof rawSession !== "string" || rawSession.trim() === "")) {
    recordExpand(deps, session, "refused", started, args);
    return "Nothing was read: session must be a non-empty session id.";
  }
  const pastSession = typeof rawSession === "string" ? rawSession : undefined;

  // A session argument naming the caller is this session's store; anything
  // else must be found on disk before a single character is read.
  if (pastSession !== undefined && pastSession !== session) {
    if (deps.isReader?.(callerSessionID) === true) {
      recordExpand(deps, session, "refused", started, args);
      return "Nothing was read: the reader is session-scoped, so a past session cannot be read.";
    }
    return expandPastSession(deps, session, pastSession, address, args, started, maxChars);
  }

  const store = deps.storeFor(callerSessionID);
  if (!store) {
    recordExpand(deps, session, "miss", started, args);
    return NO_STORE;
  }
  const problem = addressProblem(store, address);
  if (problem !== undefined) {
    recordExpand(deps, session, "refused", started, args);
    return problem;
  }
  const view = readAddressed(store, deps.redact, address, args, maxChars);
  recordExpand(deps, session, view.ok ? "hit" : "miss", started, args);
  return view.text;
}

function expandPastSession(
  deps: RecallToolDeps,
  session: string,
  pastSession: string,
  address: Address,
  args: Record<string, unknown>,
  started: number,
  maxChars: number,
): string {
  if (!deps.openPast) {
    recordExpand(deps, session, "refused", started, args);
    return deps.pastReadUnreachableText ?? DEFAULT_PAST_READ_UNREACHABLE;
  }
  const opened = deps.openPast(session, pastSession);
  if (opened.kind !== "opened") {
    recordExpand(deps, session, "refused", started, args);
    return opened.kind === "missing"
      ? `Nothing was read: no stored session with id ${pastSession}.`
      : `Nothing was read: session ${pastSession} could not be opened (an older generation, or in use).`;
  }
  try {
    const problem = addressProblem(opened.store, address);
    if (problem !== undefined) {
      recordExpand(deps, session, "refused", started, args);
      return problem;
    }
    const view = readAddressed(opened.store, deps.redact, address, args, maxChars);
    recordExpand(deps, session, view.ok ? "hit" : "miss", started, args);
    if (!view.ok) return view.text;
    return (
      `[lcm:session ${opened.sessionId}] This is a past session's history, not this session's, and it is read only.\n\n` +
      view.text
    );
  } finally {
    opened.store.close();
  }
}

/** Parse `id`/`entry_id` args into an `Address`: error text when malformed, undefined when neither is present. */
export function readAddress(args: Record<string, unknown>): Address | string | undefined {
  const hasId = args.id !== undefined;
  const hasEntry = args.entry_id !== undefined;
  if (hasId && (typeof args.id !== "number" || !Number.isInteger(args.id) || args.id <= 0)) {
    return "Nothing was read: id must be a positive integer.";
  }
  if (hasEntry && (typeof args.entry_id !== "string" || args.entry_id.trim() === "")) {
    return "Nothing was read: entry_id must be a non-empty string.";
  }
  if (hasEntry) {
    const entryId = args.entry_id as string;
    return {
      kind: "entry",
      entryId,
      ...(typeof args.id === "number" ? { id: args.id } : {}),
    };
  }
  if (typeof args.id === "number") return { kind: "summary", id: args.id };
  return undefined;
}

/** Refusal text when an address names no stored summary or message, else undefined. */
export function addressProblem(store: LcmStore, address: Address): string | undefined {
  if (address.kind === "summary") {
    return store.getSummary(address.id) ? undefined : `No summary with id ${address.id}.`;
  }
  if (!store.hasEntry(address.entryId)) {
    return `No stored message with entry id ${address.entryId}.`;
  }
  if (address.id !== undefined && !store.getSummary(address.id)) {
    return `No summary with id ${address.id}.`;
  }
  return undefined;
}

/** Read a validated address with `char_offset` paging capped at `maxChars` characters. */
export function readAddressed(
  store: LcmStore,
  redact: (text: string) => string,
  address: Address,
  args: Record<string, unknown>,
  maxChars: number,
): { ok: boolean; text: string } {
  if (address.kind === "entry") {
    return expandView(store, redact, {
      mode: "message",
      ...(address.id === undefined ? {} : { id: address.id }),
      entryId: address.entryId,
      charOffset: typeof args.char_offset === "number" ? args.char_offset : 0,
      maxChars,
    });
  }
  return expandView(store, redact, {
    mode: "list",
    id: address.id,
    offset: typeof args.offset === "number" ? args.offset : 0,
    limit: typeof args.limit === "number" ? args.limit : 25,
    maxChars,
  });
}

/** Classify an `lcm_expand` reply as hit, miss, refused, or error for metric rows. */
export function expandQueryOutcome(text: string): "hit" | "miss" | "refused" | "error" {
  if (text === NO_STORE) return "miss";
  if (text.startsWith("Nothing was read")) return "refused";
  if (
    text.startsWith("Retrieval failed") ||
    text.startsWith("Retrieval timed out") ||
    text.startsWith("The reader returned no text")
  ) {
    return "error";
  }
  return "hit";
}

function sessionFor(deps: Pick<RecallToolDeps, "sessionOf">, callerSessionID: string): string {
  return deps.sessionOf?.(callerSessionID) ?? callerSessionID;
}

function recordRecall(
  deps: Pick<RecallToolDeps, "record">,
  session: string,
  row: Record<string, unknown>,
): void {
  deps.record?.({ ts: Date.now(), session, kind: "recall", ...row });
}

function recordExpand(
  deps: Pick<RecallToolDeps, "record">,
  session: string,
  outcome: "hit" | "miss" | "refused" | "error",
  started: number,
  args: Record<string, unknown>,
): void {
  recordRecall(deps, session, {
    tool: "lcm_expand",
    outcome,
    durationMs: Date.now() - started,
    ...(typeof args.id === "number" ? { summaryId: args.id } : {}),
    ...(typeof args.entry_id === "string" ? { entryId: args.entry_id } : {}),
  });
}

function asScope(raw: unknown): RecallScope | undefined {
  return typeof raw === "string" && (RECALL_SCOPES as readonly string[]).includes(raw)
    ? (raw as RecallScope)
    : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  return input as Record<string, unknown>;
}
