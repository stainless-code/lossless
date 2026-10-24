import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import type { FinishReason, GenerateOptions, TokenUsage } from "@deepseek-ai/dsh-llm";
import type {
  CompletionRequest,
  ModelAnswer,
  ModelHost,
  ModelRef,
  Notices,
  Usage,
} from "lossless-core";
import { zeroCostUsageOfTokens } from "lossless-core";

/** One model route on the composition: the provider key that selects the
 * adapter instance, and the model id that adapter serves. */
export interface DshRoute {
  readonly provider: string;
  readonly model: string;
}

export interface DshHostOptions {
  /** The route `session()` answers with. Absent until the plugin wires config. */
  readonly defaultRoute?: DshRoute;
  /** Abort for every call this host makes. The reader owns its own signal. */
  readonly signal?: AbortSignal;
}

/** One ref for one route. `reasoning` stays false until the host resolves
 * model info, so a reasoning model never silently spends the output cap. */
export function dshRef(route: DshRoute): ModelRef<DshRoute> {
  return { key: `${route.provider}/${route.model}`, reasoning: false, model: route };
}

/** The core port over one streaming call. `session()` answers the configured
 * default route, `find()` builds a ref for any well-formed request and lets
 * the stream fail `NO_ADAPTER` for routes nothing registered, and `complete()`
 * sends the pre-joined prompt as one user message with `purpose: compaction`. */
export function dshModelHost(ctx: Context, options?: DshHostOptions): ModelHost<DshRoute> {
  const signal = options?.signal;
  const fallback = options?.defaultRoute;
  return {
    notices: { kind: "none" } satisfies Notices,
    session: () => (fallback === undefined ? undefined : dshRef(fallback)),
    find: (requested) =>
      requested.provider.length > 0 && requested.id.length > 0
        ? dshRef({ provider: requested.provider, model: requested.id })
        : undefined,
    complete: (model, request) => complete(ctx, { signal, ref: model, request }),
  };
}

interface CompleteArgs {
  readonly signal: AbortSignal | undefined;
  readonly ref: ModelRef<DshRoute>;
  readonly request: CompletionRequest;
}

async function complete(ctx: Context, args: CompleteArgs): Promise<ModelAnswer> {
  const assembler = new BlockAssembler();
  const options: GenerateOptions = {
    provider: args.ref.model.provider,
    model: args.ref.model.model,
    messages: [{ role: "user", content: [{ type: "text", text: args.request.prompt }] }],
    maxTokens: args.request.maxTokens,
    purpose: "compaction",
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  };
  try {
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  } catch (error) {
    return {
      outcome: "failed",
      reason: message(error),
      capped: false,
      stop: "threw",
      usage: usageOf(assembler.usage),
    };
  }
  return answerOf(assembler);
}

/** The terminal chunk decides, with the same words Pi uses: `stop` answers,
 * `max-tokens` fails capped so the ladder stores nothing partial, and anything
 * else fails open with the provider's own code in the reason. */
function answerOf(assembler: BlockAssembler): ModelAnswer {
  const usage = usageOf(assembler.usage);
  const finish: FinishReason = assembler.finish;
  switch (finish.kind) {
    case "stop":
      return { outcome: "answer", text: joinedText(assembler), stop: finish.kind, usage };
    case "max-tokens":
      return {
        outcome: "failed",
        reason: "generation hit the token cap and the summary is incomplete",
        capped: true,
        stop: finish.kind,
        usage,
      };
    case "tool-calls":
      return {
        outcome: "failed",
        reason: "the model returned tool calls for a request that sent no tools",
        capped: false,
        stop: finish.kind,
        usage,
      };
    case "aborted":
    case "error":
      return {
        outcome: "failed",
        reason: `${finish.failure.code}: ${finish.failure.message}`,
        capped: false,
        stop: finish.kind,
        usage,
      };
    default: {
      const _exhaustive: never = finish;
      throw new Error(`unhandled finish kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function joinedText(assembler: BlockAssembler): string {
  return assembler
    .blocks()
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/** The provider's counts with no prices attached. The zeroing lives in the
 * core seam; this wrapper keeps only the TokenUsage to Usage shape. */
export function usageOf(usage: TokenUsage | undefined): Usage | undefined {
  return zeroCostUsageOfTokens(usage);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
