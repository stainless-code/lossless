import {
  DEFAULT_RETRIEVAL_TOKENS,
  MAX_EXPAND_CHARS,
  MAX_RETRIEVAL_TOKENS,
  MIN_RETRIEVAL_TOKENS,
  describeView,
  expandView,
  grepView,
} from "lossless-core";
import type { LcmStore } from "lossless-core";

import { openPastSession, searchPastSessions, type PastSessions } from "./cross-session.ts";
import type { ToolEditor, ToolExecuteContext } from "./host.ts";
import type { Reader } from "./reader.ts";

export interface RecallDeps {
  /** Sidecar by calling session. Undefined answers the no-history text, so a
   * call outside any known session fails explained rather than empty. */
  readonly store: (sessionId: string | undefined) => LcmStore | undefined;
  readonly redact: (text: string) => string;
  /** Diagnostic sink. Optional so a unit test can observe recall without a
   * metrics file; production passes `appendMetricRow`. */
  readonly record?: (row: Record<string, unknown>) => void;
  /** The sidecars a cross-session scope scans. Absent answers explained. */
  readonly pastSessions?: PastSessions;
  /** The session whose sidecar this call reads. A reader child maps to its
   * parent, so its rows and its exclusion name the parent, not the child. */
  readonly sessionOf?: (sessionId: string) => string;
  /** True for a reader child. The reader is session-scoped, so its tools
   * refuse every past-session scope. */
  readonly isReader?: (sessionId: string) => boolean;
}

export const NO_STORE =
  "LCM: no stored history for this session yet (nothing has been ingested, or the session is ephemeral).";

const SCOPES = ["session", "sessions", "all_sessions"] as const;
type RecallScope = (typeof SCOPES)[number];

/** Register the three recall tools on the host tool registry. The
 * descriptions match the loop tools core hands the reader, so both present
 * the same tools. */
export function registerRecallTools(editor: ToolEditor, deps: RecallDeps): void {
  editor.add({
    name: "lcm_grep",
    options: { codemode: false },
    description:
      "Full-text search over the stored session history. Each hit names the summary (#N) that covers it, which lcm_expand reads. `scope` widens the search: session (default) reads this session, while sessions and all_sessions read the other sessions' sidecars in this sidecar directory. OpenCode keeps one global sidecar directory, so sessions and all_sessions are equivalent today and no project index is kept. A past-session hit is a labelled pointer, [lcm:session <id>], and lcm_expand({session, entry_id}) reads it.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "FTS5 query: quoted phrases, AND/OR, prefix*",
        },
        limit: { type: "integer", description: "Hits to return" },
        scope: {
          type: "string",
          enum: [...SCOPES],
          description:
            "session (default), sessions, or all_sessions. The last two are equivalent here because the sidecar directory is global.",
        },
      },
      required: ["query"],
    },
    execute: (input, context) => Promise.resolve({ content: grepAnswer(deps, context, input) }),
  });
  editor.add({
    name: "lcm_describe",
    options: { codemode: false },
    description:
      "Inspect a summary without expanding it: kind, depth, own and source token costs, children with their costs, parents, and full text. This reads the calling session only; a past-session summary is reached by expanding its entry through lcm_expand({session, entry_id}).",
    input: {
      type: "object",
      properties: {
        id: {
          type: "integer",
          description: "Summary id, the N in [lcm:summary #N ...]",
        },
      },
      required: ["id"],
    },
    execute: (input, context) => Promise.resolve({ content: describeAnswer(deps, context, input) }),
  });
  editor.add({
    name: "lcm_expand",
    options: { codemode: false },
    description:
      "Read the original messages a summary covers, or one named entry. Without entry_id, list `limit` messages from message index `offset`. With entry_id, read that one message from `char_offset` for up to `max_chars` characters; continue from the char_offset the result reports. `id` is the summary to list, or to check that the entry is covered; omit it to read an entry that no summary covers yet. Pass `session` with the id from an [lcm:session <id>] hit to read that past session's sidecar; the text is labelled as a past session's history and the read is read-only.",
    input: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Summary id, the N in [lcm:summary #N ...]" },
        entry_id: { type: "string", description: "Read this one message by entry id" },
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
    },
    execute: (input, context) => Promise.resolve({ content: expandAnswer(deps, context, input) }),
  });
}

/** Register the fourth tool, the one that needs a child session. It is mounted
 * only with `assembly` on: the parent's context never receives the originals,
 * only the child's answer. The reader itself denies the tool in the child, so
 * an expand query cannot recurse. */
export function registerExpandQueryTool(
  editor: ToolEditor,
  reader: Reader,
  deps: Pick<RecallDeps, "record" | "sessionOf"> = {},
): void {
  editor.add({
    name: "lcm_expand_query",
    options: { codemode: false },
    description:
      "Recover content from compacted history and answer a question about it. Use it whenever lcm_grep or a summary in context points at what you need but you do not have its text. Pass summary_id to read one summary's originals, or entry_id to read one stored message; without either it searches. A bounded reader expands the stored originals and returns findings only, so the raw transcript never enters this context. Ask for verbatim quotes in `prompt` when the exact words matter. This reader is session-scoped: it reads the calling session's history, not a past session's.",
    input: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "FTS5 query: quoted phrases, AND/OR, prefix*",
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
        max_tokens: {
          type: "integer",
          minimum: MIN_RETRIEVAL_TOKENS,
          maximum: MAX_RETRIEVAL_TOKENS,
          description: `Retrieved content budget in estimated tokens (default ${DEFAULT_RETRIEVAL_TOKENS})`,
        },
      },
      required: ["query", "prompt"],
    },
    execute: async (input, context) => {
      const started = Date.now();
      const args = asRecord(input);
      const session = sessionFor(deps, context);
      let content: string;
      try {
        content = await reader.expand(context.sessionID, input);
      } catch (error) {
        recordRecall(deps, session, {
          tool: "lcm_expand_query",
          outcome: "error",
          queryChars: typeof args.query === "string" ? args.query.length : 0,
          durationMs: Date.now() - started,
          error: messageOf(error),
        });
        throw error;
      }
      recordRecall(deps, session, {
        tool: "lcm_expand_query",
        outcome: expandQueryOutcome(content),
        queryChars: typeof args.query === "string" ? args.query.length : 0,
        durationMs: Date.now() - started,
        ...(typeof args.summary_id === "number" ? { summaryId: args.summary_id } : {}),
        ...(typeof args.entry_id === "string" ? { entryId: args.entry_id } : {}),
      });
      return { content };
    },
  });
}

function storeFor(deps: RecallDeps, context: ToolExecuteContext): LcmStore | undefined {
  return deps.store(context.sessionID);
}

function sessionFor(deps: Pick<RecallDeps, "sessionOf">, context: ToolExecuteContext): string {
  return deps.sessionOf?.(context.sessionID) ?? context.sessionID;
}

function recordRecall(
  deps: Pick<RecallDeps, "record">,
  session: string,
  row: Record<string, unknown>,
): void {
  deps.record?.({ ts: Date.now(), session, kind: "recall", ...row });
}

function expandQueryOutcome(text: string): "hit" | "miss" | "refused" | "error" {
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

export function grepAnswer(deps: RecallDeps, context: ToolExecuteContext, input: unknown): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, context);
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
  if (scope !== "session" && deps.isReader?.(context.sessionID) === true) {
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
  const store = storeFor(deps, context);
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
  deps: RecallDeps,
  session: string,
  query: string,
  scope: Exclude<RecallScope, "session">,
  started: number,
  limit: unknown,
): string {
  if (!deps.pastSessions) {
    recordRecall(deps, session, {
      tool: "lcm_grep",
      outcome: "refused",
      queryChars: query.length,
      scope,
      durationMs: Date.now() - started,
    });
    return "LCM: past sessions are not reachable in this process (no sidecar directory is wired).";
  }
  const result = searchPastSessions(
    { past: deps.pastSessions, redact: deps.redact },
    session,
    query,
    typeof limit === "number" ? { limit } : {},
  );
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

export function describeAnswer(
  deps: RecallDeps,
  context: ToolExecuteContext,
  input: unknown,
): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, context);
  const store = storeFor(deps, context);
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

export function expandAnswer(
  deps: RecallDeps,
  context: ToolExecuteContext,
  input: unknown,
): string {
  const started = Date.now();
  const args = asRecord(input);
  const session = sessionFor(deps, context);
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
    if (deps.isReader?.(context.sessionID) === true) {
      recordExpand(deps, session, "refused", started, args);
      return "Nothing was read: the reader is session-scoped, so a past session cannot be read.";
    }
    return expandPastSession(deps, context, session, pastSession, address, args, started, maxChars);
  }

  const store = storeFor(deps, context);
  if (!store) {
    recordExpand(deps, session, "miss", started, args);
    return NO_STORE;
  }
  const problem = addressProblem(store, address);
  if (problem !== undefined) {
    recordExpand(deps, session, "refused", started, args);
    return problem;
  }
  const view = readAddressed(store, deps, address, args, maxChars);
  recordExpand(deps, session, view.ok ? "hit" : "miss", started, args);
  return view.text;
}

function expandPastSession(
  deps: RecallDeps,
  context: ToolExecuteContext,
  session: string,
  pastSession: string,
  address: Address,
  args: Record<string, unknown>,
  started: number,
  maxChars: number,
): string {
  if (!deps.pastSessions) {
    recordExpand(deps, session, "refused", started, args);
    return "Nothing was read: past sessions are not reachable in this process.";
  }
  const opened = openPastSession(deps.pastSessions, session, pastSession);
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
    const view = readAddressed(opened.store, deps, address, args, maxChars);
    recordExpand(deps, session, view.ok ? "hit" : "miss", started, args);
    if (!view.ok) return view.text;
    return (
      `[lcm:session ${opened.ref.id}] This is a past session's history, not this session's, and it is read only.\n\n` +
      view.text
    );
  } finally {
    opened.store.close();
  }
}

type Address =
  | { readonly kind: "summary"; readonly id: number }
  | { readonly kind: "entry"; readonly entryId: string; readonly id?: number };

function readAddress(args: Record<string, unknown>): Address | string | undefined {
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

function addressProblem(store: LcmStore, address: Address): string | undefined {
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

function readAddressed(
  store: LcmStore,
  deps: RecallDeps,
  address: Address,
  args: Record<string, unknown>,
  maxChars: number,
): { ok: boolean; text: string } {
  if (address.kind === "entry") {
    return expandView(store, deps.redact, {
      mode: "message",
      ...(address.id === undefined ? {} : { id: address.id }),
      entryId: address.entryId,
      charOffset: typeof args.char_offset === "number" ? args.char_offset : 0,
      maxChars,
    });
  }
  return expandView(store, deps.redact, {
    mode: "list",
    id: address.id,
    offset: typeof args.offset === "number" ? args.offset : 0,
    limit: typeof args.limit === "number" ? args.limit : 25,
    maxChars,
  });
}

function recordExpand(
  deps: Pick<RecallDeps, "record">,
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
  return typeof raw === "string" && (SCOPES as readonly string[]).includes(raw)
    ? (raw as RecallScope)
    : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  return input as Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
