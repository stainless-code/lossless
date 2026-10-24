import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";

import type { DshRoute } from "../../src/model-host.ts";

export function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

export function cappedChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "max-tokens" } },
  ];
}

export function errorChunks(): StreamChunk[] {
  return [
    {
      type: "finish",
      reason: { kind: "error", failure: { message: "bad key", code: "AUTH" } },
    },
  ];
}

export function toolCallChunks(callId: string, name: string, args: unknown): StreamChunk[] {
  const id = ToolCallId(callId);
  const json = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id, name, argumentsDelta: json },
    { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: json } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

/** One scripted provider route: each stream consumes the next entry and
 * records its request, so a test asserts what the host actually sent. */
export class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(
    private readonly scripts: StreamChunk[][],
    private readonly contextWindow?: number,
  ) {
    super();
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.contextWindow === undefined
        ? {}
        : { context: { contextWindow: this.contextWindow } }),
    });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const chunks = this.scripts.shift();
    if (!chunks) throw new Error("ScriptAdapter: script exhausted");
    yield* chunks;
  }
}

export function setupContext(
  route: DshRoute,
  scripts: StreamChunk[][],
  opts?: { contextWindow?: number },
): { ctx: Context; adapter: ScriptAdapter } {
  const ctx = new Context();
  void new LlmRuntime(ctx);
  const adapter = new ScriptAdapter(scripts, opts?.contextWindow);
  ctx.llm.registerAdapter([route.provider], adapter);
  return { ctx, adapter };
}
