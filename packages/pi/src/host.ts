import { fileURLToPath } from "node:url";

import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostVersion, packageVersionNear } from "lossless-core";
import type {
  CompletionRequest,
  ModelAnswer,
  ModelHost,
  ModelRef,
  Notices,
  Reader,
  ReaderCall,
  ReaderReply,
  ReaderRequest,
  ReaderResult,
  Reading,
} from "lossless-core";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The extension's own version, from the manifest that ships it. The name is
 * the check rather than a fixed number of `..` steps, and the search walks up
 * from whichever layout this module ships in: `src/` or a bundled `dist/`. */
export function pluginVersion(): string {
  return (
    packageVersionNear(fileURLToPath(import.meta.url), "pi-lossless") ?? "unknown (no package.json)"
  );
}

export function piHostVersion(): string {
  return hostVersion(PI_PACKAGE, import.meta.url);
}

export function pluginLabel(): string {
  return `pi-lossless ${pluginVersion()}`;
}

export function piHostLabel(): string {
  return `pi ${piHostVersion()}`;
}

type PiModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

export interface PiModelKey {
  readonly provider?: string;
  readonly id?: string;
}

export function piModelKey(ctx: { readonly model?: PiModelKey | undefined }): string {
  const model = ctx.model;
  if (!model?.provider || !model.id) return "";
  return `${model.provider}/${model.id}`;
}

function refOf(model: PiModel | undefined): ModelRef<PiModel> | undefined {
  if (!model?.provider || !model.id) return undefined;
  return { key: `${model.provider}/${model.id}`, reasoning: model.reasoning, model };
}

/** Pi's agent loop passes its session id on every call, and the opencode
 * providers turn it into the `x-opencode-session` routing header their
 * endpoint requires. Background calls from this seam carry no ambient session,
 * so the id travels explicitly; without it Console Go rejects the call and
 * the ladder falls back to mechanical. Other providers ignore the option. */
function sessionIdOf(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function noticesOf(ctx: ExtensionContext): Notices {
  if (!ctx.hasUI) return { kind: "none" };
  return { kind: "ui", notify: (text, level) => ctx.ui.notify(text, level) };
}

export function piModelHost(ctx: ExtensionContext): ModelHost<PiModel> {
  return {
    notices: noticesOf(ctx),
    session: () => refOf(ctx.model),
    find: (requested) => refOf(ctx.modelRegistry.find(requested.provider, requested.id)),
    complete: (model, request) => complete(ctx, model, request),
  };
}

async function complete(
  ctx: ExtensionContext,
  ref: ModelRef<PiModel>,
  request: CompletionRequest,
): Promise<ModelAnswer> {
  const response = await ctx.modelRegistry.complete(
    ref.model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: request.maxTokens, cacheRetention: "none", sessionId: sessionIdOf(ctx) },
  );
  const usage = response.usage;
  // Pi's own check: an `error` stop carries a message, and a `length` stop is
  // partial text. Neither may be stored as a summary, which is what `capped`
  // tells the core, while the wording is this seam's business.
  if (response.stopReason === "error") {
    return {
      outcome: "failed",
      reason: response.errorMessage || "unknown error",
      capped: false,
      stop: response.stopReason,
      usage,
    };
  }
  if (response.stopReason === "length") {
    return {
      outcome: "failed",
      reason: "generation hit the token cap and the summary is incomplete",
      capped: true,
      stop: response.stopReason,
      usage,
    };
  }
  return { outcome: "answer", text: joinedText(response), stop: response.stopReason, usage };
}

export function piReader(ctx: ExtensionContext, signal: AbortSignal | undefined): Reader {
  return { begin: (request) => beginReading(ctx, signal, request) };
}

function beginReading(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  request: ReaderRequest,
): Reading {
  const messages: Message[] = [{ role: "user", content: request.brief, timestamp: Date.now() }];
  let opened = false;
  return {
    async next(results: readonly ReaderResult[]): Promise<ReaderReply> {
      if (opened) for (const result of results) messages.push(toolResultMessage(result));
      opened = true;
      const model = ctx.model;
      if (!model) throw new Error("no active model for retrieval");
      const reply = await ctx.modelRegistry.complete(
        model,
        { systemPrompt: request.systemPrompt, messages, tools: [...request.tools] },
        { signal, cacheRetention: "none", sessionId: sessionIdOf(ctx) },
      );
      messages.push(reply);
      return replyOf(reply);
    },
  };
}

/** What one reader reply means, with Pi's stop words read here: `error` and
 * `aborted` fail, `toolUse` with calls asks for them, and anything else is an
 * answer, including a `length` stop whose partial text is still usable. */
function replyOf(reply: AssistantMessage): ReaderReply {
  const usage = reply.usage;
  const text = trimmedText(reply);
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return { outcome: "failed", reason: reply.errorMessage ?? reply.stopReason, usage };
  }
  const calls = reply.content.filter((block): block is ToolCall => block.type === "toolCall");
  if (reply.stopReason === "toolUse" && calls.length > 0) {
    return { outcome: "reads", calls: calls.map(readerCall), text, usage };
  }
  return { outcome: "answered", text, usage };
}

function readerCall(call: ToolCall): ReaderCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function toolResultMessage(result: ReaderResult): Message {
  return {
    role: "toolResult",
    toolCallId: result.call.id,
    toolName: result.call.name,
    content: [{ type: "text", text: result.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function joinedText(reply: AssistantMessage): string {
  return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function trimmedText(reply: AssistantMessage): string {
  return joinedText(reply).trim();
}
