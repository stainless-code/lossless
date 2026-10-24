import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { LcmStore, redactSecrets } from "lossless-core";

import { registerLcmCommand } from "./command.ts";
import { LosslessSummarizerEngine, checkpointMemory } from "./engine.ts";
import { MessageIndex, mirrorEvent } from "./ingest.ts";
import { registerRecallTools } from "./tools.ts";

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

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
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
  mkdirSync(dir, { recursive: true });
  const sidecars = new Map<string, { store: LcmStore; index: MessageIndex }>();
  const sidecarFor = (sessionId: string): { store: LcmStore; index: MessageIndex } => {
    let entry = sidecars.get(sessionId);
    if (!entry) {
      entry = {
        store: new LcmStore(join(dir, `${sanitize(sessionId)}.sqlite`)),
        index: new MessageIndex(),
      };
      sidecars.set(sessionId, entry);
    }
    return entry;
  };
  const stopMirror = ctx.on("session/event", (live, event) => {
    const entry = sidecarFor(String(live.id));
    mirrorEvent(live, event, entry.store, entry.index);
  });
  const stopTools = registerRecallTools(ctx, {
    store: (sessionId) => (sessionId === undefined ? undefined : sidecarFor(sessionId).store),
    redact: redactSecrets,
  });
  // Hydration fallback: a resumed session rebuilds its last checkpoint
  // from its sidecar until it compacts again. Reads only; a lookup miss
  // creates no store.
  const memory = checkpointMemory((sessionId) => sidecars.get(sessionId)?.store);
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
      store: (sessionId) => sidecars.get(sessionId)?.store,
      index: (sessionId) => sidecars.get(sessionId)?.index,
      memory,
      redact: redactSecrets,
      ...(config.summaryTokens === undefined ? {} : { summaryTokens: config.summaryTokens }),
      ...(config.leafChunkTokens === undefined ? {} : { leafChunkTokens: config.leafChunkTokens }),
      ...(config.bracketAuto === undefined ? {} : { bracketAuto: config.bracketAuto }),
    },
  );
  const stopCommand = registerLcmCommand(ctx, {
    stores: () => new Map([...sidecars].map(([id, entry]) => [id, entry.store])),
  });
  return () => {
    stopMirror();
    stopTools();
    stopCommand();
  };
}
