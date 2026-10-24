import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  describeAnswer as coreDescribeAnswer,
  expandAnswer as coreExpandAnswer,
  grepAnswer as coreGrepAnswer,
  type RecallToolDeps as CoreRecallDeps,
} from "lossless-core";
import type { LcmStore } from "lossless-core";

export interface RecallDeps {
  /** Sidecar by calling-agent session. Undefined answers the no-history
   * text, so a call outside any agent fails explained rather than empty. */
  readonly store: (sessionId: string | undefined) => LcmStore | undefined;
  readonly redact: (text: string) => string;
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

function toCoreDeps(deps: RecallDeps): CoreRecallDeps {
  return {
    storeFor: (sessionId) => deps.store(sessionId === "" ? undefined : sessionId),
    redact: deps.redact,
  };
}

function coreDepsFor(
  store: LcmStore | undefined,
  redact: (text: string) => string,
): CoreRecallDeps {
  return {
    storeFor: () => store,
    redact,
  };
}

export function grepAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: { query: string; limit?: number },
): string {
  return coreGrepAnswer(coreDepsFor(store, redact), "", args);
}

export function describeAnswer(
  store: LcmStore | undefined,
  redact: (text: string) => string,
  args: { id: number },
): string {
  return coreDescribeAnswer(coreDepsFor(store, redact), "", args);
}

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
  return coreExpandAnswer(coreDepsFor(store, redact), "", args);
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
