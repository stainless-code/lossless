/** Shared token and window math every harness adapter uses. The estimator
 * counts four characters per token, the overflow parser reads the window a
 * provider named, and the lookup and key helpers name a model the same way
 * in config zones and metric rows. Pi already reads the estimator and the
 * parser from the core entry; OpenCode reads the lookup and the key from
 * here through its thin wrappers, so the two adapters cannot drift. */

/** Token math shared with adapters: `tokensFromChars` counts chars at four per token, `scaledBudget` calibrates a budget. */
export { scaledBudget, tokensFromChars } from "../estimate-tokens.ts";
/** Overflow parser shared with adapters: the window in tokens a provider error names, or null. */
export { windowFromError } from "../overflow-window.ts";

/** Either provider spelling hosts use: OpenCode names `providerID`, Pi names
 * `provider`. The key ignores any other field, including an OpenCode variant,
 * because a variant changes settings and not the model itself. */
export interface ModelIdentity {
  readonly providerID?: string;
  readonly provider?: string;
  readonly id?: string;
}

/** A ref wrapper hosts pass around: the model beside its computed key. Only
 * the nested model matters for the spelling. */
export interface ModelKeyRef {
  readonly model?: ModelIdentity | undefined;
  readonly key?: string;
  readonly reasoning?: boolean;
}

/** The spelling config zones and metric rows use: `provider/id`. A wrapper
 * with a `model` field (a core `ModelRef` or a Pi context) is unwrapped, so a
 * direct model and a ref to one spell the same. Missing or empty parts spell
 * empty, the way Pi names no model before one is active. */
export function modelKey(input: ModelIdentity | ModelKeyRef | undefined | null): string {
  const model =
    typeof input === "object" &&
    input !== null &&
    "model" in input &&
    typeof (input as { model?: unknown }).model === "object" &&
    (input as { model?: unknown }).model !== null
      ? ((input as { model: ModelIdentity }).model as ModelIdentity)
      : (input as ModelIdentity | undefined | null);
  if (model === undefined || model === null) return "";
  const provider = model.providerID ?? model.provider;
  const id = model.id;
  if (typeof provider !== "string" || provider.length === 0) return "";
  if (typeof id !== "string" || id.length === 0) return "";
  return `${provider}/${id}`;
}

/** The fields a window lookup matches on. An OpenCode `ModelRef` carries an
 * optional variant besides these, which still satisfies this shape. */
export interface WindowModel {
  readonly providerID: string;
  readonly id: string;
}

/** One catalogue entry reduced to what the lookup reads. */
export interface WindowCatalogEntry {
  readonly providerID: string;
  readonly id: string;
  readonly limit: { readonly context: number };
}

/** The catalogue source the lookup reads. It is the `list` half of the host
 * model domain; the synchronous `get` stays host side. */
export interface WindowListDomain {
  list(input?: unknown): Promise<unknown>;
}

/** The context the lookup reads the catalogue from. Only the optional model
 * domain matters, so any host context with that shape satisfies it. */
export interface WindowLookupContext {
  readonly model?: WindowListDomain | undefined;
}

/** The model window lookup both assembly seams read. */
export type WindowOf<M extends WindowModel = WindowModel> = (model: M) => Promise<number>;

/** The model window both assembly seams read. The context projection measures
 * occupancy against it, and the blocking checkpoint reads the same figure for
 * its metric rows, so the catalogue is asked once for the plugin lifetime. A
 * catalogue that failed once is asked again on the next request: the host may
 * still be starting. */
export function createWindowLookup<M extends WindowModel = WindowModel>(
  ctx: WindowLookupContext,
  fallback: number,
): WindowOf<M> {
  let catalogue: Promise<readonly WindowCatalogEntry[]> | null = null;

  function models(): Promise<readonly WindowCatalogEntry[]> {
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

function isModelInfo(value: unknown): value is WindowCatalogEntry {
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
