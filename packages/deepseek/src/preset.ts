import type { Context } from "@deepseek-ai/cordis";

import { acquireCore, DEFAULT_SIDECAR_DIR } from "./core.ts";
import { LosslessSummarizerEngine } from "./engine.ts";
import { buildEngineArgs, Config, type LosslessPluginConfig } from "./plugin.ts";

/** Cordis plugin name used by loader diagnostics. Distinct from the host row
 * so host and preset fibers are told apart in activation warnings. */
export const name = "deepseek-lossless-preset";

/** Capability services the realm backend reads. Everything here resolves
 * from the outer scope: preset groups isolate only the compaction service
 * itself, so sessions, the model route, and the meter stay shared. Tools and
 * commands stay out on purpose: the host row registers recall and `/lcm`
 * once against the shared registries. */
export const inject = ["sessions", "llm", "tokenMeter"];

export { Config };
export type { LosslessPluginConfig };

/** Realm-only compaction backend for agent presets. Mounts the summarizer
 * engine against the shared host core: same sidecars, same record sink, same
 * checkpoint memory. Registers nothing else, mirrors nothing, and never
 * closes shared handles; the host row owns the core lifetime.
 *
 * Fails fast when the host row has not mounted, with the fix in the message,
 * instead of running a split-brain copy.
 * @example
 * ```ts
 * const stop = applyPreset(ctx, { enabled: true });
 * ``` */
export function apply(ctx: Context, config: LosslessPluginConfig = {}): () => void {
  if (config.enabled !== true) return () => undefined;
  const dir = config.sidecarDir ?? DEFAULT_SIDECAR_DIR;
  const core = acquireCore(dir, false);
  const [seamConfig, engineDeps] = buildEngineArgs(config, core);
  void new LosslessSummarizerEngine(ctx, seamConfig, engineDeps);
  return () => undefined;
}
