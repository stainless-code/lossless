import type { Context } from "@deepseek-ai/cordis";
import type { ModelCompactPolicyConfig } from "@deepseek-ai/dsh-compaction-basic";
import { SidecarStores, redactSecrets, type LcmStore } from "lossless-core";

import { registerLcmCommand } from "./command.ts";
import { LosslessSummarizerEngine, checkpointMemory } from "./engine.ts";
import { MessageIndex, mirrorEvent } from "./ingest.ts";
import { createRecord } from "./metrics.ts";
import { registerExpandQueryTool, registerRecallTools } from "./tools.ts";

export interface LosslessPluginConfig {
  /** Master flag. Nothing registers, mirrors, or mounts until true. */
  readonly enabled?: boolean;
  /** Automatic pressure compaction inside the turn. Default false. */
  readonly auto?: boolean;
  /** Route automatic pressure compaction through the DAG bracket instead of
   * the seam. Default false. */
  readonly bracketAuto?: boolean;
  /** Directory for one sidecar file per session. Created when missing. */
  readonly sidecarDir?: string;
  readonly summaryTokens?: number;
  readonly leafChunkTokens?: number;
  readonly summarizationProvider?: string;
  readonly summarizationModel?: string;
  /** Pressure fraction of the priced window that trips automatic compaction.
   * Seam default 0.8. Rides the seam config. */
  readonly thresholdRatio?: number;
  /** Recent context retained as an absolute token budget. Mutually exclusive
   * with retainRatio; the seam default shape is the ratio form (0.16).
   * Rides the seam config; the manual path keeps the seam's 0 retain. */
  readonly retainTokens?: number;
  /** Recent context retained as a fraction of the priced window. Seam
   * default 0.16; mutually exclusive with retainTokens. Rides the seam. */
  readonly retainRatio?: number;
  /** Pressure headroom beyond the routed output reservation. Seam default
   * 65536; the seam also defaults its summary cap to it. Rides the seam. */
  readonly headroomTokens?: number;
  /** Exact provider/model policy overrides, merged over the defaults by the
   * seam per routed target. Duplicate targets fail load. Rides the seam. */
  readonly modelPolicies?: ModelCompactPolicyConfig[];
  /** Tokens one summarizer request may cost before it is refused. Default
   * 60000. Adapter-only: never rides the seam config. */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all of its calls. Default 250000.
   * Adapter-only. */
  readonly summarizerTokensPerPass?: number;
  /** Tokens one heal run may spend across all of its calls. Default 120000.
   * Adapter-only. */
  readonly summarizerTokensPerHeal?: number;
  /** Estimated tokens one heal node may read as source. Unset derives 8 x
   * summaryTokens, clamped to 3000 through 24000 and the request budget.
   * Adapter-only. */
  readonly healSourceTokens?: number;
}

const DEFAULT_SIDECAR_DIR = "./.lossless";

/** Per-session sidecars: stores delegate to the shared core seam while each
 * session keeps its own live message index beside its store. */
class SessionSidecars extends SidecarStores {
  private readonly indexes = new Map<string, MessageIndex>();

  constructor(dir: string) {
    super({ dir });
  }

  /** Store plus live index for one session, creating both on first use. */
  entryFor(sessionId: string): { store: LcmStore; index: MessageIndex } {
    const store = this.for(sessionId);
    let index = this.indexes.get(sessionId);
    if (!index) {
      index = new MessageIndex();
      this.indexes.set(sessionId, index);
    }
    return { store, index };
  }

  /** Live index for a session without creating a store, if mirrored yet. */
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
}

/** Compose lossless memory into a harness context: mirror every session
 * into its own sidecar, register the recall tools against the calling
 * session, mount the summarizer engine as the compaction backend, and
 * register `/lcm`. Disabled by default; enable on one composition at a
 * time. The returned disposer stops the mirror, the tools, and the command.
 * The engine follows the composition lifetime. */
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
  });
  return () => {
    stopMirror();
    stopTools();
    stopExpandQuery();
    stopCommand();
  };
}
