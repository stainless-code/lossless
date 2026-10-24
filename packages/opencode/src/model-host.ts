/** The `ModelHost` seam over the plugin's `generate.text`. The host's call takes
 * no options, so the core's `maxTokens` request is not forwarded and the host
 * decides the cap from its own model limits. It returns text alone, so `usage`
 * is estimated from characters and a cut answer cannot be told from a complete
 * one: `usage.estimated` says so, `stop` stays `unknown` because the host named
 * no stop reason, and `capped` stays false. The estimate keeps the summarizer
 * budget and metrics populated without claiming a billed figure. */

import {
  modelKey,
  tokensFromChars,
  type CompletionRequest,
  type ModelAnswer,
  type ModelHost,
  type ModelRef as CoreModelRef,
  type Usage,
} from "lossless-core";

import type { ModelRef, OpencodeContext } from "./host.ts";

export { modelKey };

/** A `ModelHost` over the OpenCode plugin context. `session` is the model the
 * session last ran under; `find` resolves a catalogue entry when the host
 * exposes a synchronous lookup, and the chain then falls back to the session
 * model the way `resolveModels` always ends. */
export function opencodeModelHost(ctx: OpencodeContext, current: ModelRef): ModelHost<ModelRef> {
  return {
    notices: { kind: "none" },
    session: () => refOf(current),
    find: (requested) => {
      const info = ctx.model?.get?.(requested.provider, requested.id);
      if (info === undefined) return undefined;
      const variant =
        current.variant !== undefined &&
        current.providerID === info.providerID &&
        current.id === info.id
          ? current.variant
          : undefined;
      return refOf({
        providerID: info.providerID,
        id: info.id,
        ...(variant === undefined ? {} : { variant }),
      });
    },
    complete: (ref, request) => complete(ctx, ref, request),
  };
}

function refOf(model: ModelRef): CoreModelRef<ModelRef> {
  return { key: modelKey(model), reasoning: false, model };
}

/** The estimate uses the engine counter, because this host reports no usage.
 * Cost stays zero because this host does not price the call. */
function estimateUsage(prompt: string, text: string): Usage {
  const input = tokensFromChars(prompt.length);
  const output = tokensFromChars(text.length);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    estimated: true,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function complete(
  ctx: OpencodeContext,
  ref: CoreModelRef<ModelRef>,
  request: CompletionRequest,
): Promise<ModelAnswer> {
  if (ctx.generate === undefined) {
    return {
      outcome: "failed",
      reason: "the host context exposes no generate.text",
      capped: false,
      stop: "error",
      usage: undefined,
    };
  }
  try {
    const answer = await ctx.generate.text({
      prompt: request.prompt,
      model: ref.model,
    });
    return {
      outcome: "answer",
      text: answer.text,
      stop: "unknown",
      usage: estimateUsage(request.prompt, answer.text),
    };
  } catch (error) {
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
      capped: false,
      stop: "error",
      usage: undefined,
    };
  }
}
