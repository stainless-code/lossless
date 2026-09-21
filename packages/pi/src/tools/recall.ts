import { join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LcmStore } from "lossless-core";
import type { Reader, Usage } from "lossless-core";
import { appendMetric, billedCounters } from "lossless-core";
import { describeView, grepView, type ViewResult } from "lossless-core";
import {
  formatSessionHits,
  openSessionStore,
  SEARCH_SCOPE_HELP,
  searchSessions,
  SESSION_HITS_LIMIT,
  sessionsForScope,
} from "lossless-core";
import {
  DEFAULT_RETRIEVAL_TOKENS,
  MAX_RETRIEVAL_TOKENS,
  MIN_RETRIEVAL_TOKENS,
  RETRIEVAL_STEPS,
  runRetrieval,
  type RetrievalScope,
} from "lossless-core";
import { type Static, Type } from "typebox";

const GrepParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "FTS5 search query (supports quoted phrases, AND/OR, prefix*)",
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description:
        "JavaScript regular expression over the full text of every stored message, including text past the 100,000 characters the search index holds. Case-insensitive unless case_sensitive is set. Give one of query or pattern, not both.",
    }),
  ),
  case_sensitive: Type.Optional(
    Type.Boolean({ description: "Match a pattern with its own case (default false)" }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Hits to skip, for the next page" }),
  ),
  after: Type.Optional(
    Type.String({
      description:
        "Continue a pattern scan from this entry id, which is the `after` value a deadline stop names",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "Hits one page holds (default 20)" }),
  ),
  summary_id: Type.Optional(
    Type.Integer({ description: "Restrict hits to the messages this summary covers" }),
  ),
  include_removed: Type.Optional(
    Type.Boolean({
      description: "Include matches from a branch that left the active path (excluded by default)",
    }),
  ),
  // StringEnum rather than a union of literals: Pi's own guidance is that an
  // anyOf schema does not survive Google's API, and this parameter decides which
  // store the call reads.
  scope: Type.Optional(
    StringEnum(["session", "sessions", "all_sessions"] as const, {
      description: SEARCH_SCOPE_HELP,
    }),
  ),
});

const DescribeParams = Type.Object({
  id: Type.Integer({ description: "Summary id, the N in [lcm:summary #N ...]" }),
});

const ExpandQueryParams = Type.Object({
  query: Type.String({ description: "What to search for in the stored history" }),
  prompt: Type.String({
    description:
      "What to find out, and the form the answer should take (ask for a verbatim quote when the exact words matter)",
  }),
  summary_id: Type.Optional(
    Type.Integer({
      description: "Read this summary's originals: the N from an [lcm:summary #N ...] header",
    }),
  ),
  entry_id: Type.Optional(
    Type.String({ description: "Read this one stored message: the entry id a grep hit names" }),
  ),
  session: Type.Optional(
    Type.String({
      description:
        "The session hash from an [lcm:session ...] pointer: read that past session's store instead of this one. Its text is returned labelled as a past session's content, and it is never injected into the context.",
    }),
  ),
  max_tokens: Type.Optional(
    Type.Integer({
      minimum: MIN_RETRIEVAL_TOKENS,
      maximum: MAX_RETRIEVAL_TOKENS,
      description: `Retrieved content budget in estimated tokens (default ${DEFAULT_RETRIEVAL_TOKENS})`,
    }),
  ),
});

function expandScope(params: {
  summary_id?: number;
  entry_id?: string;
}): RetrievalScope | string | undefined {
  if (params.summary_id !== undefined && params.entry_id !== undefined) {
    return "pass summary_id or entry_id, not both";
  }
  if (params.summary_id !== undefined) return { kind: "summary", summaryId: params.summary_id };
  if (params.entry_id === undefined) return undefined;
  if (params.entry_id.length === 0) return "entry_id is empty";
  return { kind: "entry", entryId: params.entry_id };
}

export interface ToolResultShape {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  usage?: Usage;
}

export interface SessionRoots {
  sessionsRoot: string;
  storesDir: string;
  cwd: string;
  excludeHash?: string;
}

export interface RecallDeps {
  store: () => LcmStore | undefined;
  session: () => string;
  redact: (text: string) => string;
  sessions?: () => SessionRoots | undefined;
}

type RecallTool = "lcm_grep" | "lcm_describe";
type RecallOutcome = "hit" | "miss" | "error";

function recordRecall(
  tool: RecallTool,
  outcome: RecallOutcome,
  session: string,
  details: Record<string, unknown>,
): void {
  const num = (key: string) => {
    const v = details[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const hits = num("hits");
  const id = num("id");
  const depth = num("depth");
  const tokens = num("tokens");
  const scanned = num("sessionsScanned");
  const skipped = num("sessionsSkipped");
  appendMetric({
    event: "lcm",
    kind: "recall",
    session,
    tool,
    outcome,
    ...(hits === undefined ? {} : { hits }),
    ...(id === undefined ? {} : { id }),
    ...(depth === undefined ? {} : { depth }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(scanned === undefined ? {} : { sessionsScanned: scanned }),
    ...(skipped === undefined ? {} : { sessionsSkipped: skipped }),
  });
}

function textResult(text: string, details?: Record<string, unknown>): ToolResultShape {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
  };
}

function viewResult(view: ViewResult): ToolResultShape {
  return view.ok
    ? { content: [{ type: "text", text: view.text }], details: view.details }
    : textResult(view.text);
}

export function createGrepTool(deps: RecallDeps) {
  return {
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search session history, including content already compacted out of the visible context. Use when you need a fact, decision, file path, or command from earlier in the session that is no longer visible. Pass `query` for a full-text search, or `pattern` for a JavaScript regular expression over the full text of every message: the pattern path matches punctuation (`lcm:summary #12`, `foo.bar(`, `->`) that the token index cannot, and reads past the 100,000 characters the index holds, at the cost of a wall-clock deadline, a 200,000-character cap per message, and its hits marked `[lcm:scan-partial ...]` when that cap bites. Hits come in pages of 20 unless `limit` says otherwise, and `offset` reaches the next page; a pattern never reports a total, so its footer says whether more exist rather than claiming a count. Matches from a branch that left the active path are excluded unless include_removed is set. Each hit names the summary (#N) that covers it, so lcm_describe(N) inspects it and lcm_expand_query recovers its text; summary_id restricts the search to one summary's messages. `scope` widens the search to past sessions, in this project or in every project. A cross-session hit is a pointer labelled [lcm:session <hash>] rather than text, and lcm_expand_query({session, entry_id}) reads it.",
    promptSnippet: "Search compacted session history by keyword",
    promptGuidelines: [
      "Use lcm_grep to find content that has left the visible context, including earlier file paths, commands, and decisions.",
    ],
    parameters: GrepParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GrepParams>,
    ): Promise<ToolResultShape> {
      const scope = params.scope ?? "session";
      if (scope !== "session") return searchPastSessions(deps, params, scope);
      const s = deps.store();
      if (!s)
        return textResult(
          "LCM: no stored history for this session yet (nothing has been ingested, or the session is ephemeral).",
        );
      const view = grepView(s, deps.redact, {
        query: params.query,
        pattern: params.pattern,
        caseSensitive: params.case_sensitive,
        offset: params.offset,
        after: params.after,
        limit: params.limit,
        summaryId: params.summary_id,
        includeRemoved: params.include_removed,
      });
      const hits = view.ok && typeof view.details.hits === "number" ? view.details.hits : undefined;
      recordRecall(
        "lcm_grep",
        !view.ok ? "error" : hits === 0 ? "miss" : "hit",
        deps.session(),
        view.ok ? view.details : {},
      );
      return viewResult(view);
    },
  };
}

function searchPastSessions(
  deps: RecallDeps,
  params: { query?: string; pattern?: string; limit?: number },
  scope: "sessions" | "all_sessions",
): ToolResultShape {
  const roots = deps.sessions?.();
  if (!roots) {
    return textResult(
      "LCM: past sessions are not reachable in this process (no session directory is wired).",
    );
  }
  if (params.pattern !== undefined) {
    return textResult("LCM: a pattern scan searches this session. Pass query for past sessions.");
  }
  if (params.query === undefined) {
    return textResult("LCM: pass a query to search past sessions.");
  }
  const refs = sessionsForScope({
    scope,
    sessionsRoot: roots.sessionsRoot,
    storesDir: roots.storesDir,
    cwd: roots.cwd,
    ...(roots.excludeHash === undefined ? {} : { excludeHash: roots.excludeHash }),
  });
  const result = searchSessions(refs, params.query, {
    limit: Math.min(params.limit ?? SESSION_HITS_LIMIT, SESSION_HITS_LIMIT),
  });
  const skipped =
    result.skipped.missing + result.skipped.unreadable + result.skipped["older-generation"];
  recordRecall("lcm_grep", result.hits.length === 0 ? "miss" : "hit", deps.session(), {
    hits: result.hits.length,
    sessionsScanned: result.scanned,
    sessionsSkipped: skipped,
  });
  return textResult(formatSessionHits(result, deps.redact), {
    hits: result.hits.length,
    scanned: result.scanned,
    skipped: result.skipped,
    sessions: [...new Set(result.hits.map((h) => h.session))],
    truncated: result.truncated,
    elapsedMs: result.elapsedMs,
  });
}

export function createDescribeTool(deps: RecallDeps) {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Inspect an LCM summary without expanding it. Given the N from an [lcm:summary #N ...] header in context, returns its kind, depth, token count, covered span, what a full expansion of it would cost, DAG neighbours with their costs, and full text.",
    parameters: DescribeParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof DescribeParams>,
    ): Promise<ToolResultShape> {
      const s = deps.store();
      if (!s)
        return textResult(
          "LCM: no stored history for this session yet (nothing has been ingested, or the session is ephemeral).",
        );
      const view = describeView(s, deps.redact, params.id);
      recordRecall("lcm_describe", view.ok ? "hit" : "miss", deps.session(), {
        id: params.id,
        ...(view.ok ? view.details : {}),
      });
      return viewResult(view);
    },
  };
}

export interface ExpandQueryDeps {
  store: () => LcmStore | undefined;
  sessions?: () => SessionRoots | undefined;
  session: () => string;
  redact: (text: string) => string;
  reader: (ctx: ExtensionContext, signal: AbortSignal | undefined) => Reader;
}

export function createExpandQueryTool(deps: ExpandQueryDeps) {
  return {
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Recover content from compacted history and answer a question about it. Use it whenever lcm_grep or a summary in context points at what you need but you do not have its text. Pass summary_id to read one summary's originals, or entry_id to read one stored message; without either it searches. A bounded reader expands the stored originals and returns findings only, so the raw transcript never enters this context. Ask for verbatim quotes in `prompt` when the exact words matter.",
    promptSnippet: "Recover compacted history and answer from it",
    promptGuidelines: [
      "Use lcm_expand_query to read text you do not have: it is the only way to recover compacted history, and it answers from the stored originals instead of paraphrasing them.",
      "When an [lcm:summary #N ...] header or a grep hit names what you need, pass summary_id or entry_id so the reader reads that source instead of searching for it.",
      "An [lcm:session <hash> ...] pointer came from a past session: pass that hash as session together with the entry_id, and the answer is labelled as a past session's history rather than this one's.",
    ],
    parameters: ExpandQueryParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ExpandQueryParams>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ): Promise<ToolResultShape> {
      const budgetTokens = params.max_tokens ?? DEFAULT_RETRIEVAL_TOKENS;
      const scope = expandScope(params);
      if (typeof scope === "string") {
        appendMetric({
          event: "lcm",
          kind: "retrieval",
          session: deps.session(),
          queryChars: params.query.length,
          budgetTokens,
          steps: 0,
          retrievedTokens: 0,
          stop: "refused",
          reason: scope,
        });
        return textResult(`Nothing was read: ${scope}.`);
      }
      const address: RetrievalScope | undefined = scope === undefined ? undefined : scope;
      const past = params.session === undefined ? undefined : openPastSession(deps, params.session);
      if (past !== undefined && "problem" in past) {
        return textResult(`Nothing was read: ${past.problem}.`);
      }
      const target = past === undefined ? deps.store() : past.store;
      if (!target)
        return textResult(
          "LCM: no stored history for this session yet (nothing has been ingested, or the session is ephemeral).",
        );
      try {
        const run = await runRetrieval(
          target,
          {
            query: params.query,
            prompt: params.prompt,
            budgetTokens,
            maxSteps: RETRIEVAL_STEPS,
            redact: deps.redact,
            ...(address === undefined ? {} : { scope: address }),
          },
          deps.reader(ctx, signal),
        );
        appendMetric({
          event: "lcm",
          kind: "retrieval",
          session: deps.session(),
          queryChars: params.query.length,
          budgetTokens,
          steps: run.steps,
          retrievedTokens: run.retrievedTokens,
          stop: run.kind,
          reason: run.kind === "answered" ? undefined : run.reason,
          ...(address === undefined ? {} : { scope: address.kind }),
          ...(address?.kind === "summary" ? { summaryId: address.summaryId } : {}),
          ...(address?.kind === "entry" ? { entryId: address.entryId } : {}),
          ...billedCounters(run.usage),
        });
        const details = {
          stop: run.kind,
          ...(run.kind === "answered" ? {} : { reason: run.reason }),
          steps: run.steps,
          retrievedTokens: run.retrievedTokens,
          budgetTokens,
        };
        if (run.kind === "refused") {
          return textResult(`Nothing was read: ${run.reason}.`, details);
        }
        if (run.kind === "failed") {
          return { ...textResult(`Retrieval failed: ${run.reason}`, details), usage: run.usage };
        }
        if (run.kind === "stopped" && run.text.length === 0) {
          return {
            ...textResult(
              `Retrieval stopped (${run.reason}) after ${run.steps} step(s) without an answer; narrow the query or raise max_tokens.`,
              details,
            ),
            usage: run.usage,
          };
        }
        const stopped = run.kind === "stopped" ? `, stopped: ${run.reason}` : "";
        const where =
          params.session === undefined
            ? "stored history"
            : `a past session's history (session ${params.session})`;
        const header = `Read ${where} in ${run.steps} step(s) (${run.retrievedTokens} of ${budgetTokens} tokens)${stopped}.`;
        const tag =
          params.session === undefined
            ? "recovered_findings"
            : `recovered_findings session="${params.session}"`;
        return {
          content: [
            {
              type: "text",
              text: `${header}\n<${tag}>\n${run.text}\n</recovered_findings>`,
            },
          ],
          details,
          usage: run.usage,
        };
      } finally {
        if (past !== undefined) target.close();
      }
    },
  };
}

function openPastSession(
  deps: ExpandQueryDeps,
  hash: string,
): { store: LcmStore } | { problem: string } {
  const roots = deps.sessions?.();
  if (!roots) return { problem: "past sessions are not reachable in this process" };
  if (!/^[0-9a-f]{16}$/.test(hash)) return { problem: `session ${hash} is not a session hash` };
  const opened = openSessionStore({
    hash,
    sessionFile: "",
    storePath: join(roots.storesDir, `${hash}.db`),
    cwd: roots.cwd,
    sessionId: "",
    when: 0,
  });
  if (opened.kind === "skipped")
    return { problem: `session ${hash} could not be read (${opened.reason})` };
  return { store: opened.store };
}
