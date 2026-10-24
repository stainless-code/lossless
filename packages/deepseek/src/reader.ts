import type { Context } from "@deepseek-ai/cordis";
import {
  BlockAssembler,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  RequestMessage,
  ToolSchema,
} from "@deepseek-ai/dsh-llm";
import type {
  ModelRef,
  Reader,
  ReaderCall,
  ReaderReply,
  ReaderRequest,
  ReaderResult,
  Reading,
} from "lossless-core";

import type { DshRoute } from "./model-host.ts";
import { usageOf } from "./model-host.ts";

export interface DshReaderOptions {
  readonly ref: ModelRef<DshRoute>;
  readonly signal?: AbortSignal;
}

/** The core reader port over one streaming call per step. The loop owns the
 * transcript the way Pi does: each step sends the brief plus every answered
 * call so far, and a step that asks for reads appends its assistant message
 * before the results land. Tool schemas pass through untouched. */
export function dshReader(ctx: Context, options: DshReaderOptions): Reader {
  return { begin: (request) => beginReading(ctx, options, request) };
}

function beginReading(ctx: Context, options: DshReaderOptions, request: ReaderRequest): Reading {
  const messages: RequestMessage[] = [
    { role: "user", content: [{ type: "text", text: request.brief }] },
  ];
  let opened = false;
  return {
    async next(results: readonly ReaderResult[]): Promise<ReaderReply> {
      if (opened) for (const result of results) messages.push(toolResultMessage(result));
      opened = true;
      const assembler = new BlockAssembler();
      const stream: GenerateOptions = {
        provider: options.ref.model.provider,
        model: options.ref.model.model,
        system: request.systemPrompt,
        messages,
        tools: request.tools.map(toolSchema),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      try {
        for await (const chunk of ctx.llm.stream(stream)) assembler.push(chunk);
      } catch (error) {
        return { outcome: "failed", reason: message(error), usage: usageOf(assembler.usage) };
      }
      const usage = usageOf(assembler.usage);
      let blocks: ContentBlock[];
      try {
        blocks = assembler.blocks();
      } catch (error) {
        return { outcome: "failed", reason: message(error), usage };
      }
      const reply = replyOf(assembler.finish, blocks, usage);
      if (reply.outcome === "reads") {
        messages.push(assistantMessage(options.ref, blocks));
      }
      return reply;
    },
  };
}

/** What one reader step means, with the same words Pi uses: error and aborted
 * fail, calls ask for execution, and anything else answers, including a
 * max-tokens stop whose partial text stays usable. */
function replyOf(
  finish: FinishReason,
  blocks: ContentBlock[],
  usage: ReaderReply["usage"],
): ReaderReply {
  switch (finish.kind) {
    case "error":
    case "aborted":
      return {
        outcome: "failed",
        reason: `${finish.failure.code}: ${finish.failure.message}`,
        usage,
      };
    case "stop":
    case "max-tokens":
    case "tool-calls":
      break;
    default: {
      const _exhaustive: never = finish;
      throw new Error(`unhandled finish kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
  const calls: ReaderCall[] = [];
  for (const block of blocks) {
    if (block.type !== "tool-call") continue;
    const parsed: unknown = safeParse(block.arguments);
    if (!isRecord(parsed)) {
      return {
        outcome: "failed",
        reason: `tool call ${block.id} carries arguments that are not a JSON object`,
        usage,
      };
    }
    calls.push({ id: block.id, name: block.name, arguments: parsed });
  }
  if (calls.length > 0) return { outcome: "reads", calls, text: joinedText(blocks), usage };
  if (finish.kind === "tool-calls") {
    return { outcome: "failed", reason: "the model finished with tool-calls but sent none", usage };
  }
  return { outcome: "answered", text: joinedText(blocks), usage };
}

function toolSchema(tool: { name: string; description: string; parameters: unknown }): ToolSchema {
  if (!isRecord(tool.parameters)) throw new Error(`tool ${tool.name} has no parameters object`);
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function assistantMessage(ref: ModelRef<DshRoute>, blocks: ContentBlock[]) {
  return createAssistantMessage({
    content: blocks,
    source: { provider: ref.model.provider, model: ref.model.model },
  });
}

function toolResultMessage(result: ReaderResult) {
  return createToolResultMessage({
    callId: ToolCallId(result.call.id),
    content: [{ type: "text", text: result.text }],
    isError: false,
  });
}

function joinedText(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
