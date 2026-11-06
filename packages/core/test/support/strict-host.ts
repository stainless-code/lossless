import type { ModelHost } from "../../src/host.ts";
import { fakeHost, type FakeHost, type FakeModel } from "./fake-host.ts";

export interface StrictHost {
  readonly host: ModelHost<string>;
  /** Calls the provider accepted, in order. */
  readonly calls: FakeHost["calls"];
  /** Calls this double rejected, with the budget it was asked for. */
  readonly refused: { model: string; maxTokens: number }[];
}

function rejection(maxTokens: number): string {
  const kind = Number.isInteger(maxTokens) ? "negative integer" : "floating point";
  return `422: Failed to deserialize the JSON body into the target type: max_tokens: invalid type: ${kind} ${maxTokens}, expected u32`;
}

/** A host double that validates the output budget the way a strict provider
 * does, so a budget that would fail on the wire fails here instead of being
 * silently coerced by the double. */
export function strictHost(models: readonly FakeModel[], session?: string): StrictHost {
  const fake = fakeHost(models, session);
  const refused: StrictHost["refused"] = [];
  return {
    calls: fake.calls,
    refused,
    host: {
      ...fake.host,
      async complete(ref, request) {
        if (!Number.isInteger(request.maxTokens) || request.maxTokens < 0) {
          refused.push({ model: ref.key, maxTokens: request.maxTokens });
          throw new Error(rejection(request.maxTokens));
        }
        return fake.host.complete(ref, request);
      },
    },
  };
}
