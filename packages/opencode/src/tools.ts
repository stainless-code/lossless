import {
  DEFAULT_RETRIEVAL_TOKENS,
  expandQueryOutcome,
  MAX_RETRIEVAL_TOKENS,
  MIN_RETRIEVAL_TOKENS,
  NO_STORE,
  RECALL_SCOPES,
  describeAnswer as coreDescribeAnswer,
  expandAnswer as coreExpandAnswer,
  grepAnswer as coreGrepAnswer,
  type RecallToolDeps as CoreRecallDeps,
} from "lossless-core";

import { openPastSession, searchPastSessions, type PastSessions } from "./cross-session.ts";
import type { ToolEditor, ToolExecuteContext } from "./host.ts";
import type { Reader } from "./reader.ts";

export interface RecallDeps {
  /** Sidecar by calling session. Undefined answers the no-history text, so a
   * call outside any known session fails explained rather than empty. */
  readonly store: (sessionId: string | undefined) => ReturnType<CoreRecallDeps["storeFor"]>;
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

export { NO_STORE };

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
          enum: [...RECALL_SCOPES],
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

export function grepAnswer(deps: RecallDeps, context: ToolExecuteContext, input: unknown): string {
  return coreGrepAnswer(toCoreDeps(deps), context.sessionID, input);
}

export function describeAnswer(
  deps: RecallDeps,
  context: ToolExecuteContext,
  input: unknown,
): string {
  return coreDescribeAnswer(toCoreDeps(deps), context.sessionID, input);
}

export function expandAnswer(
  deps: RecallDeps,
  context: ToolExecuteContext,
  input: unknown,
): string {
  return coreExpandAnswer(toCoreDeps(deps), context.sessionID, input);
}

function toCoreDeps(deps: RecallDeps): CoreRecallDeps {
  if (!deps.pastSessions) {
    return {
      storeFor: (sessionId) => deps.store(sessionId),
      redact: deps.redact,
      record: deps.record,
      sessionOf: deps.sessionOf,
      isReader: deps.isReader,
    };
  }
  const past = deps.pastSessions;
  return {
    storeFor: (sessionId) => deps.store(sessionId),
    redact: deps.redact,
    record: deps.record,
    sessionOf: deps.sessionOf,
    isReader: deps.isReader,
    searchPast: (session, query, scope, limit) => {
      const result = searchPastSessions(
        { past, redact: deps.redact },
        session,
        query,
        typeof limit === "number" ? { limit } : {},
      );
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

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return {};
  return input as Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
