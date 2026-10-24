import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_RETRIEVAL_TOKENS,
  NO_STORE,
  RETRIEVAL_STEPS,
  billedCounters,
  describeAnswer as coreDescribeAnswer,
  expandAnswer as coreExpandAnswer,
  grepAnswer as coreGrepAnswer,
  runRetrieval,
  type Reader,
  type RecallToolDeps as CoreRecallDeps,
  type RetrievalScope,
} from "lossless-core";
import type { LcmStore } from "lossless-core";

import type { DshRoute } from "./model-host.ts";
import { dshRef } from "./model-host.ts";
import { dshReader } from "./reader.ts";

export interface RecallDeps {
  /** Sidecar by calling-agent session. Undefined answers the no-history
   * text, so a call outside any agent fails explained rather than empty. */
  readonly store: (sessionId: string | undefined) => LcmStore | undefined;
  readonly redact: (text: string) => string;
  /** Diagnostic sink for retrieval rows. Optional, so a test can observe
   * retrieval without a metrics file; the JSONL writer is a later slice. */
  readonly record?: (row: Record<string, unknown>) => void;
}

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
  return {
    storeFor: (sessionId) => deps.store(sessionId === "" ? undefined : sessionId),
    redact: deps.redact,
    ...(deps.record === undefined ? {} : { record: deps.record }),
  };
}

/** Session-less answer for tests: binds one store through the single
 * converter above with the empty session id. */
export function grepAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: { query: string; limit?: number },
): string {
  return coreGrepAnswer(toCoreDeps({ store: () => store, redact }), "", args);
}

/** Session-less answer for tests: see grepAnswer. */
export function describeAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: { id: number },
): string {
  return coreDescribeAnswer(toCoreDeps({ store: () => store, redact }), "", args);
}

/** Session-less answer for tests: see grepAnswer. */
export function expandAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: {
    id?: number;
    entry_id?: string;
    offset?: number;
    limit?: number;
    char_offset?: number;
    max_chars?: number;
  },
): string {
  return coreExpandAnswer(toCoreDeps({ store: () => store, redact }), "", args);
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
): Promise<string> {
  const deps: RecallDeps = {
    store: () => store,
    redact,
    ...(record === undefined ? {} : { record }),
  };
  return answerExpandQuery(toCoreDeps(deps), reader, sessionId, args);
}

/** What the reader answers when the caller names no prompt: the question
 * itself, answered from the stored history with citations. */
const DEFAULT_EXPAND_QUERY_PROMPT =
  "Answer the question from the stored history, citing the entry or summary ids relied on.";

/** Answered retrieval behind `lcm_expand_query`, mirroring Pi's expand-query
 * tool: the `session` param resolves through the same store lookup as the
 * calling session (no cross-session directory search), and every run that
 * reaches past validation emits one retrieval-kind row when a recorder is
 * present. Findings stay wrapped so the raw transcript never enters the
 * caller's context. */
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
  const target =
    args.session === undefined ? deps.storeFor(sessionId ?? "") : deps.storeFor(args.session);
  if (!target) return NO_STORE;
  const run = await runRetrieval(
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
  const header =
    `Read stored history in ${run.steps} step(s) ` +
    `(${run.retrievedTokens} of ${budgetTokens} tokens)${stopped}.`;
  return `${header}\n<recovered_findings>\n${run.text}\n</recovered_findings>`;
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
  const header = agent?.session.requestHeader()?.config;
  if (header !== undefined && header.provider.length > 0 && header.model.length > 0) {
    return { provider: header.provider, model: header.model };
  }
  const options = agent?.options;
  if (
    options?.provider !== undefined &&
    options.provider.length > 0 &&
    options.model !== undefined &&
    options.model.length > 0
  ) {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

function sessionOf(exec: ToolRunContext): string | undefined {
  const id = exec.agent?.session.id;
  return id === undefined ? undefined : String(id);
}

function lcmGrepTool(deps: RecallDeps) {
  return defineTool({
    name: "lcm_grep",
    description:
      "Full-text search over the stored session history. Each hit names the summary (#N) that covers it, which lcm_expand reads.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "FTS5 query: quoted phrases, AND/OR, prefix*",
      },
      limit: { type: "integer", description: "Hits to return" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return coreGrepAnswer(toCoreDeps(deps), sessionOf(exec) ?? "", args);
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
      "Read the original messages a summary covers, or one named entry. Without entry_id, list `limit` messages from message index `offset`. With entry_id, read that one message from `char_offset` for up to `max_chars` characters; continue from the char_offset the result reports. `id` is the summary to list, or to check that the entry is covered; omit it to read an entry that no summary covers yet.",
    parameters: {
      id: { type: "integer", description: "Summary id, the N in [lcm:summary #N ...]" },
      entry_id: { type: "string", description: "Read this one message by entry id" },
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
        dshReader(ctx, { ref: dshRef(route), signal: exec.signal }),
        sessionId,
        args,
      );
    },
  });
}
