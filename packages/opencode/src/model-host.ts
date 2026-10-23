/** The `ModelHost` seam over the plugin's `generate.text`. The host's call takes
 * no options, so the core's `maxTokens` request is not forwarded and the host
 * decides the cap from its own model limits. It returns text alone, so `usage`
 * is estimated from characters and a cut answer cannot be told from a complete
 * one, which is why `capped` stays false. The estimate keeps the summarizer
 * budget and metrics populated without claiming a billed figure. */

import type {
  CompletionRequest,
  ModelAnswer,
  ModelHost,
  ModelRef as CoreModelRef,
  Usage,
} from "lossless-core";

import type { ModelRef, OpencodeContext } from "./host.ts";

/** The spelling config zones and metric rows use: `provider/id`, without the
 * variant, because a variant changes settings and not the model itself. */
export function modelKey(ref: CoreModelRef<ModelRef>): string {
  return `${ref.model.providerID}/${ref.model.id}`;
}

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
  return { key: modelKey({ key: "", reasoning: false, model }), reasoning: false, model };
}

/** Four characters per token, the same constant the engine uses when a host
 * reports no counters. Cost stays zero because this host does not price the
 * call. */
function estimateUsage(prompt: string, text: string): Usage {
  const input = Math.ceil(prompt.length / 4);
  const output = Math.ceil(text.length / 4);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
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
      stop: "end",
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
