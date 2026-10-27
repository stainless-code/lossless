import type { Context } from "@deepseek-ai/cordis";

import { acquireCore, releaseCore } from "./core.ts";
import { LosslessSummarizerEngine } from "./engine.ts";
import {
  buildEngineArgs,
  closeIdleStores,
  Config,
  readSidecarDir,
  type LosslessPluginConfig,
} from "./plugin.ts";

/** Cordis plugin name used by loader diagnostics. Distinct from the host row
 * so host and preset fibers are told apart in activation warnings. */
export const name = "deepseek-lossless-preset";

/** Capability services the realm backend reads. Everything here resolves
 * from the outer scope: preset groups isolate only the compaction service
 * itself, so sessions, the model route, and the meter stay shared. Tools and
 * commands stay out on purpose: the host row registers recall and `/lcm`
 * once against the shared registries. */
export const inject = ["sessions", "llm", "tokenMeter"];

/** The loader schema, identical to the host row's: the preset row takes the
 * same composition options, including `enabled` and `sidecarDir`. */
export { Config };
export type { LosslessPluginConfig };

/** Realm-only compaction backend for agent presets. Pairs with the host
 * row's `apply`/`applyLossless`, which must mount first: this entry mounts
 * the summarizer engine against the shared host core (same sidecars, same
 * record sink, same checkpoint memory) and registers nothing else. It
 * mirrors nothing, and it closes only idle shared handles when its own
 * release is the last ownership count left.
 *
 * Fails fast when the host row has not mounted, with the fix in the message,
 * instead of running a split-brain copy.
 * @example
 * ```ts
 * const stop = apply(ctx, { enabled: true });
 * ``` */
export function apply(ctx: Context, config: LosslessPluginConfig = {}): () => void {
  if (config.enabled !== true) return () => undefined;
  const dir = readSidecarDir(config.sidecarDir).dir;
  const core = acquireCore(dir, false);
  const [seamConfig, engineDeps] = buildEngineArgs(config, core);
  void new LosslessSummarizerEngine(ctx, seamConfig, engineDeps);
  // Borrowers release like owners: when this release drops the last
  // ownership count, sweep the shared idle stores so repeated mounts cannot
  // accumulate open handles. Live and healing stores stay open. Once-only,
  // like the host.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (releaseCore(core)) {
      closeIdleStores(core, (message) => ctx.logger.warn(message));
    }
  };
}
