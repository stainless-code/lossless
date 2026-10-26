import type { Context } from "@deepseek-ai/cordis";
import type { ModelCompactPolicyConfig } from "@deepseek-ai/dsh-compaction-basic";
import z from "@deepseek-ai/schemastery";
import { SidecarStores, redactSecrets, type LcmStore } from "lossless-core";

import { registerLcmCommand } from "./command.ts";
import { LosslessSummarizerEngine, checkpointMemory } from "./engine.ts";
import { MessageIndex, backfillSession, historySourceFrom, mirrorEvent } from "./ingest.ts";
import { healInFlightSessions } from "./lifecycle.ts";
import { createRecord } from "./metrics.ts";
import { registerExpandQueryTool, registerRecallTools } from "./tools.ts";

/** Composition options for `applyLossless`. Each field carries its own default. */
export interface LosslessPluginConfig {
  /** Master flag. Nothing registers, mirrors, or mounts until true.
   * @default false */
  readonly enabled?: boolean;
  /** Automatic pressure compaction inside the turn.
   * @default false */
  readonly auto?: boolean;
  /** Route automatic pressure compaction through the DAG bracket instead of
   * the seam.
   * @default false */
  readonly bracketAuto?: boolean;
  /** Directory for one sidecar file per session. Created when missing.
   * @default "./.lossless" */
  readonly sidecarDir?: string;
  /** Tokens one summary aims for. Rides the engine deps, not the seam.
   * @default 1500 */
  readonly summaryTokens?: number;
  /** Tokens one leaf chunk may hold before it splits. Rides the engine
   * deps, not the seam.
   * @default 3000 */
  readonly leafChunkTokens?: number;
  /** Provider the summarizer calls. Unset follows the routed model.
   * @default unset */
  readonly summarizationProvider?: string;
  /** Model the summarizer calls. Unset follows the routed model.
   * @default unset */
  readonly summarizationModel?: string;
  /** Pressure fraction of the priced window that trips automatic compaction.
   * Rides the seam config.
   * @default 0.8 */
  readonly thresholdRatio?: number;
  /** Recent context retained as an absolute token budget. Mutually exclusive
   * with retainRatio; the seam default shape is the ratio form (0.16).
   * Rides the seam config; the manual path keeps the seam's 0 retain. */
  readonly retainTokens?: number;
  /** Recent context retained as a fraction of the priced window. Mutually
   * exclusive with retainTokens. Rides the seam.
   * @default 0.16 */
  readonly retainRatio?: number;
  /** Pressure headroom beyond the routed output reservation. The seam also
   * defaults its summary cap to it. Rides the seam.
   * @default 65536 */
  readonly headroomTokens?: number;
  /** Exact provider/model policy overrides, merged over the defaults by the
   * seam per routed target. Duplicate targets fail load. Rides the seam. */
  readonly modelPolicies?: ModelCompactPolicyConfig[];
  /** Tokens one summarizer request may cost before it is refused.
   * Adapter-only: never rides the seam config.
   * @default 60000 */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all of its calls. Adapter-only.
   * @default 250000 */
  readonly summarizerTokensPerPass?: number;
  /** Tokens one heal run may spend across all of its calls. Adapter-only.
   * @default 120000 */
  readonly summarizerTokensPerHeal?: number;
  /** Estimated tokens one heal node may read as source. Unset derives 8 x
   * summaryTokens, clamped to 3000 through 24000 and the request budget.
   * Adapter-only.
   * @default 8 x summaryTokens, clamped 3000..24000 */
  readonly healSourceTokens?: number;
  /** Tool names whose spans compact without a model call. Empty keeps the
   * LLM path. Adapter-only: never rides the seam config.
   * @default [] */
  readonly mechanicalTools?: readonly string[];
}

const DEFAULT_SIDECAR_DIR = "./.lossless";

/** Cordis plugin name used by loader diagnostics. */
export const name = "deepseek-lossless";

/** Capability services the composition reads. Session query stays out:
 * history backfill degrades gracefully without it, so it remains optional.
 * Compaction stays out: the composition provides it, so requiring it would
 * deadlock startup. */
export const inject = ["sessions", "tools", "commands", "llm", "tokenMeter"];

/** Loader schema for the composition options. Mirrors
 * `LosslessPluginConfig` with loader defaults and generated docs. */
export const Config = z.object({
  enabled: z.boolean().default(false),
  auto: z.boolean().default(false),
  bracketAuto: z.boolean().default(false),
  sidecarDir: z.string().default(DEFAULT_SIDECAR_DIR),
  summaryTokens: z.number().step(1).min(1).default(1500),
  leafChunkTokens: z.number().step(1).min(1).default(3000),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  thresholdRatio: z.number().min(0).default(0.8),
  retainTokens: z.number().step(1).min(1),
  retainRatio: z.number().min(0).default(0.16),
  headroomTokens: z.number().step(1).min(1).default(65536),
  modelPolicies: z.array(z.any()),
  summarizerTokensPerCall: z.number().step(1).min(1).default(60000),
  summarizerTokensPerPass: z.number().step(1).min(1).default(250000),
  summarizerTokensPerHeal: z.number().step(1).min(1).default(120000),
  healSourceTokens: z.number().step(1).min(1),
  mechanicalTools: z.array(z.string()).default([]),
});

/** Cordis plugin entrypoint. Delegates to `applyLossless` so the loader
 * and direct composition share one path. */
export function apply(ctx: Context, config: LosslessPluginConfig = {}): () => void {
  return applyLossless(ctx, config);
}

/** Per-session sidecars: stores delegate to the shared core seam while each
 * session keeps its own live message index beside its store. */
class SessionSidecars extends SidecarStores {
  private readonly indexes = new Map<string, MessageIndex>();

  constructor(dir: string) {
    super({ dir });
  }

  entryFor(sessionId: string): { store: LcmStore; index: MessageIndex } {
    const store = this.for(sessionId);
    let index = this.indexes.get(sessionId);
    if (!index) {
      index = new MessageIndex();
      this.indexes.set(sessionId, index);
    }
    return { store, index };
  }

  peekIndex(sessionId: string): MessageIndex | undefined {
    return this.indexes.get(sessionId);
  }

  storesMap(): Map<string, LcmStore> {
    const map = new Map<string, LcmStore>();
    for (const id of this.ids()) {
      const store = this.peek(id);
      if (store) map.set(id, store);
    }
    return map;
  }

  override clear(): void {
    super.clear();
    this.indexes.clear();
  }

  override evict(sessionId: string): void {
    super.evict(sessionId);
    this.indexes.delete(sessionId);
  }
}

/** Compose lossless memory into a harness context: mirror every session
 * into its own sidecar, register the recall tools against the calling
 * session, mount the summarizer engine as the compaction backend, and
 * register `/lcm`. Disabled by default; enable on one composition at a
 * time. The returned disposer stops the mirror, the tools, and the command,
 * and closes every open sidecar. The engine follows the composition lifetime.
 * @example
 * ```ts
 * const stop = applyLossless(ctx, { enabled: true });
 * ``` */
export function applyLossless(ctx: Context, config: LosslessPluginConfig = {}): () => void {
  if (config.enabled !== true) return () => undefined;
  const dir = config.sidecarDir ?? DEFAULT_SIDECAR_DIR;
  const sidecars = new SessionSidecars(dir);
  const stopMirror = ctx.on("session/event", (live, event) => {
    const entry = sidecars.entryFor(String(live.id));
    mirrorEvent(live, event, entry.store, entry.index);
  });
  // One recorder per composition: recall, ladder-run, and bracket rows all
  // land in the same sidecar directory as the stores they describe.
  const record = createRecord(dir);
  // Pre-mount backfill: sessions already live when the plugin mounts mirror
  // their earlier history through the same mirrorEvent path as the live feed
  // above, paged and capped so a huge log cannot stall mount. The query
  // backend is optional: without it only new events are mirrored. Contained
  // per session and never rejecting, so mount cannot fail over history.
  // Tool names that skip the model. One name or a list; blanks and repeats
  // drop, and an empty result keeps the LLM path.
  const readMechanicalTools = (raw: unknown): string[] | undefined => {
    const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
    if (list === undefined) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const name = entry.trim();
      if (name.length === 0) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out.length === 0 ? undefined : out;
  };
  const mechanicalTools = readMechanicalTools(config.mechanicalTools);
  const history = historySourceFrom(ctx);
  if (history !== undefined) {
    const pending = ctx.sessions.list().map((session) => {
      const entry = sidecars.entryFor(String(session.id));
      return backfillSession(session, entry.store, history, entry.index, { record }).catch(
        (error: unknown) => {
          ctx.logger.warn(
            `lossless backfill skipped session "${String(session.id)}": ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    });
    void Promise.all(pending);
  }
  const stopTools = registerRecallTools(ctx, {
    store: (sessionId) =>
      sessionId === undefined ? undefined : sidecars.entryFor(sessionId).store,
    redact: redactSecrets,
    record,
    pastSessions: { list: (exclude) => sidecars.list(exclude) },
  });
  const stopExpandQuery = registerExpandQueryTool(ctx, {
    store: (sessionId) =>
      sessionId === undefined ? undefined : sidecars.entryFor(sessionId).store,
    redact: redactSecrets,
    record,
    pastSessions: { list: (exclude) => sidecars.list(exclude) },
  });
  // Hydration fallback: a resumed session rebuilds its last checkpoint
  // from its sidecar until it compacts again. Reads only; a lookup miss
  // creates no store.
  const memory = checkpointMemory((sessionId) => sidecars.peek(sessionId));
  void new LosslessSummarizerEngine(
    ctx,
    {
      auto: config.auto ?? false,
      ...(config.summarizationProvider === undefined
        ? {}
        : { summarizationProvider: config.summarizationProvider }),
      ...(config.summarizationModel === undefined
        ? {}
        : { summarizationModel: config.summarizationModel }),
      // Seam policy knobs only: the seam's resolveConfig rejects unknown
      // keys, so every adapter-only key stays on our own deps below.
      ...(config.thresholdRatio === undefined ? {} : { thresholdRatio: config.thresholdRatio }),
      ...(config.retainTokens === undefined ? {} : { retainTokens: config.retainTokens }),
      ...(config.retainRatio === undefined ? {} : { retainRatio: config.retainRatio }),
      ...(config.headroomTokens === undefined ? {} : { headroomTokens: config.headroomTokens }),
      ...(config.modelPolicies === undefined ? {} : { modelPolicies: config.modelPolicies }),
    },
    {
      store: (sessionId) => sidecars.peek(sessionId),
      index: (sessionId) => sidecars.peekIndex(sessionId),
      memory,
      redact: redactSecrets,
      record,
      ...(config.summaryTokens === undefined ? {} : { summaryTokens: config.summaryTokens }),
      ...(config.leafChunkTokens === undefined ? {} : { leafChunkTokens: config.leafChunkTokens }),
      ...(config.bracketAuto === undefined ? {} : { bracketAuto: config.bracketAuto }),
      ...(config.summarizerTokensPerCall === undefined
        ? {}
        : { summarizerTokensPerCall: config.summarizerTokensPerCall }),
      ...(config.summarizerTokensPerPass === undefined
        ? {}
        : { summarizerTokensPerPass: config.summarizerTokensPerPass }),
      ...(config.summarizerTokensPerHeal === undefined
        ? {}
        : { summarizerTokensPerHeal: config.summarizerTokensPerHeal }),
      ...(config.healSourceTokens === undefined
        ? {}
        : { healSourceTokens: config.healSourceTokens }),
      ...(mechanicalTools === undefined ? {} : { mechanicalTools }),
    },
  );
  const stopCommand = registerLcmCommand(ctx, {
    stores: () => sidecars.storesMap(),
    storeFor: (sessionId) => sidecars.for(sessionId),
    sidecarDir: dir,
    storePathFor: (sessionId) => sidecars.pathFor(sessionId),
    // The heal verbs budget from these; unset keys keep core defaults.
    ...(config.summaryTokens === undefined ? {} : { summaryTokens: config.summaryTokens }),
    ...(config.summarizerTokensPerCall === undefined
      ? {}
      : { summarizerTokensPerCall: config.summarizerTokensPerCall }),
    ...(config.summarizerTokensPerHeal === undefined
      ? {}
      : { summarizerTokensPerHeal: config.summarizerTokensPerHeal }),
    ...(config.healSourceTokens === undefined ? {} : { healSourceTokens: config.healSourceTokens }),
    // The heal model rides these; unset keeps the agent route fallback.
    ...(config.summarizationProvider === undefined
      ? {}
      : { summarizationProvider: config.summarizationProvider }),
    ...(config.summarizationModel === undefined
      ? {}
      : { summarizationModel: config.summarizationModel }),
    // Status and diagnose report effective values from these seam keys.
    ...(config.thresholdRatio === undefined ? {} : { thresholdRatio: config.thresholdRatio }),
    ...(config.retainTokens === undefined ? {} : { retainTokens: config.retainTokens }),
    ...(config.retainRatio === undefined ? {} : { retainRatio: config.retainRatio }),
    ...(config.headroomTokens === undefined ? {} : { headroomTokens: config.headroomTokens }),
    ...(config.modelPolicies === undefined ? {} : { modelPolicies: config.modelPolicies }),
  });
  return () => {
    stopMirror();
    stopTools();
    stopExpandQuery();
    stopCommand();
    // Dispose-then-use is an error: a live run keeps its store open so the commit can land, and a session under heal repair keeps its store for the same reason.
    const healing = new Set(healInFlightSessions());
    for (const [id, store] of sidecars.storesMap()) {
      try {
        if (store.hasLiveRun() || healing.has(id)) continue;
        store.close();
        sidecars.evict(id);
      } catch {}
    }
  };
}
