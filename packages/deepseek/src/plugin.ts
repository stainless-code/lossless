import type { Context } from "@deepseek-ai/cordis";
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
    },
  );
  const stopCommand = registerLcmCommand(ctx, {
    stores: () => sidecars.storesMap(),
    storeFor: (sessionId) => sidecars.for(sessionId),
    sidecarDir: dir,
    storePathFor: (sessionId) => sidecars.pathFor(sessionId),
  });
  return () => {
    stopMirror();
    stopTools();
    stopExpandQuery();
    stopCommand();
  };
}
