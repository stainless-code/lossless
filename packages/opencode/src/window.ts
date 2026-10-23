/** The model window both assembly seams read. The context projection measures
 * occupancy against it, and the blocking checkpoint reads the same figure for
 * its metric rows, so the catalogue is asked once for the plugin lifetime. A
 * catalogue that failed once is asked again on the next request: the host may
 * still be starting. */

import type { ModelInfo, ModelRef, OpencodeContext } from "./host.ts";

export type WindowOf = (model: ModelRef) => Promise<number>;

export function createWindowLookup(ctx: OpencodeContext, fallback: number): WindowOf {
  let catalogue: Promise<readonly ModelInfo[]> | null = null;

  function models(): Promise<readonly ModelInfo[]> {
    if (catalogue) return catalogue;
    const domain = ctx.model;
    if (domain === undefined) return Promise.resolve([]);
    const pending = domain.list().then(
      (result) =>
        isRecord(result) && Array.isArray(result.data) ? result.data.filter(isModelInfo) : [],
      () => {
        // A catalogue that failed once is worth asking again next request.
        catalogue = null;
        return [];
      },
    );
    catalogue = pending;
    return pending;
  }

  return async (model) => {
    const info = (await models()).find(
      (candidate) => candidate.providerID === model.providerID && candidate.id === model.id,
    );
    const window = info?.limit.context;
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : fallback;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    isRecord(value) &&
    typeof value.providerID === "string" &&
    typeof value.id === "string" &&
    isRecord(value.limit) &&
    typeof value.limit.context === "number" &&
    Number.isFinite(value.limit.context) &&
    value.limit.context > 0
  );
}
