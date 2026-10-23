import { fileURLToPath } from "node:url";

import {
  HEAL_SOURCE_MAX_TOKENS,
  SUMMARIZER_CALL_TOKENS,
  SUMMARIZER_PASS_TOKENS,
  LcmStore,
  makeLlm,
  packageVersionNear,
  redactSecrets,
  runHeal,
  type LlmComplete,
  type MetricsSink,
  type ThresholdConfig,
} from "lossless-core";

import { statusCommand, statusLine, passCommand, reportCommand } from "./command.ts";
import { createCheckpointWriter } from "./compaction.ts";
import { createContextProjector, type ProjectionOptions } from "./context.ts";
import type { ModelRef, OpencodeContext, Registration, SessionMessageInfo } from "./host.ts";
import { compactionMark, mirror, mirrorBusEvent, toolEntry, userEntry } from "./ingest.ts";
import {
  backupCommand,
  diagnoseCommand,
  exportCommand,
  gcCommand,
  healCommand,
  importCommand,
  migrateCommand,
  type LifecycleDeps,
} from "./lifecycle.ts";
import { storedEntries } from "./map.ts";
import { appendMetricRow } from "./metrics.ts";
import { opencodeModelHost } from "./model-host.ts";
import { runLosslessPass } from "./pass.ts";
import { DEFAULT_READER_TIMEOUT_MS, createReader } from "./reader.ts";
import { Sidecars } from "./sidecars.ts";
import { SUMMARIZER_HEAL_TOKENS, summarizerConfig } from "./summarizer.ts";
import { registerExpandQueryTool, registerRecallTools } from "./tools.ts";
import { createWindowLookup } from "./window.ts";

export const PLUGIN_ID = "opencode-lossless";

/** Options read from the plugin's `plugins[].options` entry. Every field is
 * optional; an unknown or malformed value keeps its default rather than
 * failing the plugin load. */
export interface OpencodeLosslessOptions {
  /** Master flag. Nothing registers, mirrors, or mounts until true, unless
   * the flag is absent, in which case listing the plugin is intent enough.
   * @default true */
  readonly enabled?: boolean;
  /** Directory for one sidecar file per session. Created when missing.
   * @default "./.lossless" (resolved from the server working directory) */
  readonly sidecarDir?: string;
  /** Wire the context projection, the blocking checkpoint, the reader, and the
   * on-demand `lossless-pass` command. `false` leaves compaction to the host and
   * registers only the mirror, the three recall tools, and the commands.
   * @default true
   * @example { assembly: false } */
  readonly assembly?: boolean;
  /** Models the pass tries for its summaries, in order. `auto` is the session
   * model; this host has no synchronous model lookup, so a concrete id falls
   * back to the session model.
   * @default "auto" */
  readonly summarizer?: string | string[];
  /** Tokens one summarizer request may cost, estimate plus output cap, before
   * it is refused rather than paid for.
   * @default 60000 */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all of its calls, counted from what the
   * provider reported.
   * @default 250000 */
  readonly summarizerTokensPerPass?: number;
  /** Tokens one `/lossless-heal --apply` run may spend across all of its calls.
   * A dry run spends nothing.
   * @default 120000 */
  readonly summarizerTokensPerHeal?: number;
  /** The occupancy share at which a request swaps in the projection. The
   * engine clamps it to 0.9 of the window.
   * @default 0.7 */
  readonly swapAtRatio?: number;
  /** The occupancy share at which a new cut replaces the pinned one.
   * @default 0.85 */
  readonly recutAtRatio?: number;
  /** Absolute token count where model quality starts to degrade, used in
   * place of `swapAtRatio`. The recut is derived from it.
   * @default unset */
  readonly smartZone?: number;
  /** Per-model threshold overrides, keyed `provider/model`. */
  readonly zones?: Readonly<Record<string, ThresholdConfig>>;
  /** Tokens the projection keeps verbatim after the cut.
   * @default 20000 */
  readonly keepRecentTokens?: number;
  /** Tokens one summary aims for.
   * @default 1500 */
  readonly summaryTokens?: number;
  /** Estimated tokens one heal node may read as source. Defaults to
   * `8 * summaryTokens`, clamped to 3,000 through 24,000 and to
   * `summarizerTokensPerCall`. It is a whole-node window, not a per-message
   * clip. Raise it to repair summaries over unusually large source messages.
   * @default 8 x summaryTokens, clamped 3000..24000 */
  readonly healSourceTokens?: number;
  /** Window used when the host catalogue cannot name this model's limit.
   * @default 128000 */
  readonly contextWindow?: number;
  /** How long one `lcm_expand_query` child may run before it is interrupted.
   * @default 120000 */
  readonly readerTimeoutMs?: number;
}

const DEFAULT_SIDECAR_DIR = "./.lossless";
const DEFAULT_SWAP_RATIO = 0.7;
const DEFAULT_RECUT_RATIO = 0.85;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_SUMMARY_TOKENS = 1500;
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** The extension's own version, from the manifest that ships it. */
export function pluginVersion(): string {
  return (
    packageVersionNear(fileURLToPath(import.meta.url), "opencode-lossless") ??
    "unknown (no package.json)"
  );
}

export function pluginLabel(): string {
  return `opencode-lossless ${pluginVersion()}`;
}

/** Wire lossless memory into an OpenCode v2 plugin context: mirror prompts,
 * assistant text, tool traffic, and compaction boundaries into per-session
 * sidecars, and register the recall tools plus the `/lossless-status`,
 * `/lossless-report`, `/lossless-pass`, and `/lossless-heal` commands. With
 * `assembly` (the default), also register the context projection and the blocking checkpoint
 * (`session.compaction`); `/lossless-pass` runs one DAG pass over the session's
 * stored span on demand. The host stops summarizing for itself once the sidecar
 * covers the aged span: it stores the DAG frontier as its checkpoint, and the
 * next request's projection continues from it. The sidecar keeps every address
 * the reader can name. Resolves to the cleanup that unregisters everything and
 * closes the sidecars. The context is the local structural subset
 * (`./host.ts`), so the real host context flows in without the bundle naming
 * the host SDK. `rawOptions` is validated at runtime; a malformed value
 * degrades to defaults rather than throwing into the host load. */
export async function setupOpencodeLossless(
  ctx: OpencodeContext,
  rawOptions?: unknown,
): Promise<() => Promise<void>> {
  const options = readOptions(rawOptions);
  if (options.enabled === false) return async () => undefined;
  const sidecars = new Sidecars(options.sidecarDir);
  const registrations: Registration[] = [];
  const windowOf = createWindowLookup(ctx, options.contextWindow);
  const record = (row: Record<string, unknown>): void => appendMetricRow(sidecars.dir, row);
  const failMirror = (sessionID: string, error: unknown): void => {
    appendMetricRow(sidecars.dir, {
      ts: Date.now(),
      session: sessionID,
      kind: "ingest",
      action: "fail",
      error: errorText(error),
    });
  };
  const reader = createReader({
    session: ctx.session,
    sidecars,
    redact: redactSecrets,
    timeoutMs: options.readerTimeoutMs,
  });
  const checkpoint = options.assembly
    ? createCheckpointWriter({ ctx, options, sidecars, windowOf })
    : undefined;

  registrations.push(
    await ctx.session.hook("prompt", (event) => {
      // A retired reader has no session and no store. Late bus traffic for it
      // must not reopen the sidecar that was just deleted.
      if (reader.isReader(event.sessionID) && !reader.isActive(event.sessionID)) return;
      try {
        mirror(sidecars.for(event.sessionID), userEntry(event.sessionID, event));
      } catch (error) {
        failMirror(event.sessionID, error);
      }
    }),
  );
  registrations.push(
    await ctx.tool.hook("execute.after", (event) => {
      if (reader.isReader(event.sessionID) && !reader.isActive(event.sessionID)) return;
      try {
        mirror(sidecars.for(event.sessionID), toolEntry(event));
      } catch (error) {
        failMirror(event.sessionID, error);
      }
    }),
  );
  registrations.push(
    await ctx.session.hook("compaction", async (event) => {
      // A reader child is a leaf: its transcript is never compacted and its
      // sidecar never becomes a checkpoint.
      if (reader.isReader(event.sessionID)) return;
      try {
        mirror(sidecars.for(event.sessionID), compactionMark(event.sessionID, event));
      } catch (error) {
        failMirror(event.sessionID, error);
      }
      await checkpoint?.apply(event);
    }),
  );
  registrations.push(
    await ctx.tool.transform((editor) => {
      registerRecallTools(editor, {
        // A reader child reads the parent's sidecar, never its own.
        store: (sessionId) =>
          sessionId === undefined ? undefined : sidecars.peek(reader.storeSession(sessionId)),
        redact: redactSecrets,
        record,
        pastSessions: { list: (excludeSessionId) => sidecars.list(excludeSessionId) },
        sessionOf: (sessionID) => reader.storeSession(sessionID),
        isReader: (sessionID) => reader.isReader(sessionID),
      });
    }),
  );
  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add(
        statusCommand({
          lines: () =>
            sidecars.ids().map((id) => {
              const store = sidecars.peek(id);
              if (!store) return `${id}: no store`;
              const stats = store.stats();
              return statusLine(id, sidecars.pathFor(id), {
                messages: stats.messages,
                summaries: store.entryCountWithPrefix(`${id}:summary:`),
              });
            }),
          prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
        }),
      );
      editor.add(
        reportCommand({
          dir: sidecars.dir,
          prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
        }),
      );
    }),
  );

  registrations.push(
    await ctx.command.transform((editor) => {
      const healingSessions = new Set<string>();
      const lifecycle: LifecycleDeps = {
        sidecars,
        options: {
          assembly: options.assembly,
          swapAtRatio: options.swapAtRatio,
          recutAtRatio: options.recutAtRatio,
          keepRecentTokens: options.keepRecentTokens,
          ...(options.smartZone === undefined ? {} : { smartZone: options.smartZone }),
          ...summarizerConfig(options),
          summarizerTokensPerHeal: options.summarizerTokensPerHeal,
          ...(options.zones === undefined ? {} : { zones: options.zones }),
        },
        version: pluginLabel,
        host: () => "opencode v2",
        prompt: (sessionID: string, text: string) => ctx.session.prompt({ sessionID, text }),
        record,
        model: async (sessionID: string) => sessionModel(await ctx.session.context({ sessionID })),
        window: windowOf,
        heal: async ({ sessionID, span, dryRun, maxNodes }) => {
          if (healingSessions.has(sessionID)) {
            throw new Error("a heal is already running for this session");
          }
          // A heal can outlive the plugin instance that started it: the host
          // reloads plugins when its watched files change. Sidecars held by the
          // plugin are closed on that reload, so the repair owns a separate
          // connection for the duration of the run.
          const runStore = new LcmStore(sidecars.pathFor(sessionID));
          if (runStore.hasLiveRun()) {
            runStore.close();
            throw new Error("a compaction pass is in flight; retry the heal");
          }
          healingSessions.add(sessionID);
          const sink: MetricsSink = (row) => record({ ...row });
          const input = {
            session: sessionID,
            targetTokens: options.summaryTokens,
            callBudgetTokens: options.summarizerTokensPerCall,
            maxTokens: options.summarizerTokensPerHeal,
            redact: redactSecrets,
            ...(options.healSourceTokens === undefined
              ? {}
              : { sourceTokens: options.healSourceTokens }),
            ...(maxNodes === undefined ? {} : { maxNodes }),
          };
          try {
            if (dryRun) {
              const noModel: LlmComplete = Object.assign(
                async (): Promise<string> => {
                  throw new Error("lcm: a heal dry run makes no model call");
                },
                { metrics: sink },
              );
              return await runHeal(runStore, { ...input, dryRun: true }, noModel);
            }
            const model = sessionModel(await ctx.session.context({ sessionID }));
            if (model === undefined) {
              throw new Error("this session has no model to repair summaries with");
            }
            const llm = makeLlm(
              opencodeModelHost(ctx, model),
              {
                ...summarizerConfig(options),
                summarizerTokensPerPass: options.summarizerTokensPerHeal,
              },
              {
                session: sessionID,
                stage: "heal",
                span: { firstEntryId: span.first, lastEntryId: span.last },
                sink,
              },
            );
            if (llm === null) throw new Error("no summarizer model is available for this repair");
            return await runHeal(runStore, input, llm);
          } finally {
            runStore.close();
            healingSessions.delete(sessionID);
          }
        },
      };
      for (const make of [
        backupCommand,
        exportCommand,
        importCommand,
        diagnoseCommand,
        migrateCommand,
        gcCommand,
        healCommand,
      ]) {
        editor.add(make(lifecycle));
      }
    }),
  );

  if (options.assembly) {
    const projector = createContextProjector({ ctx, options, sidecars, windowOf });
    registrations.push(
      await ctx.session.hook("context", (event) => {
        // The reader child gets one system part, its instructions, and nothing
        // else: the agent prompt and the parent's projection both stay out.
        if (reader.isReader(event.sessionID)) {
          reader.resetSystem(event.system);
          return;
        }
        return projector.project(event);
      }),
    );
    registrations.push(
      await ctx.tool.transform((editor) => {
        registerExpandQueryTool(editor, reader, {
          record,
          sessionOf: (sessionID) => reader.storeSession(sessionID),
        });
      }),
    );
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add(
          passCommand({
            run: async (sessionID) => {
              const messages = await ctx.session.context({ sessionID });
              const mapped = storedEntries(sessionID, messages);
              const model = sessionModel(messages);
              if (model === undefined) {
                // An empty history needs no model and no pass.
                if (mapped.entries.length === 0) {
                  return { kind: "nothing", reason: "no-entries", ingested: 0 };
                }
                throw new Error("this session has no model to summarize with");
              }
              return runLosslessPass(
                { store: (id) => sidecars.for(id), ctx, model, record },
                sessionID,
                mapped.entries,
                {
                  targetTokens: options.summaryTokens,
                  stage: "direct",
                  summarizer: summarizerConfig(options),
                },
              );
            },
            prompt: (sessionID, text) => ctx.session.prompt({ sessionID, text }),
          }),
        );
      }),
    );
  }

  let stopped = false;
  let current: AsyncIterator<unknown> | undefined;
  let wake: ReturnType<typeof setTimeout> | undefined;
  const handle = (value: unknown): void => {
    if (stopped) return;
    let sessionId: string | undefined;
    try {
      const event = value as {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly data?: unknown;
      };
      if (typeof event?.type !== "string") return;
      if (event.type !== "session.text.ended" && event.type !== "session.compaction.ended") {
        return;
      }
      const data =
        typeof event.data === "object" && event.data !== null
          ? (event.data as { readonly sessionID?: unknown })
          : undefined;
      sessionId = typeof data?.sessionID === "string" ? data.sessionID : undefined;
      if (sessionId === undefined) return;
      if (reader.isReader(sessionId) && !reader.isActive(sessionId)) return;
      mirrorBusEvent(sidecars.for(sessionId), {
        id: typeof event.id === "string" ? event.id : undefined,
        type: event.type,
        data: event.data,
      });
    } catch (error) {
      // One bad event must not end the subscription for the rest of the
      // process. The hooks and tools keep working either way.
      if (sessionId !== undefined) failMirror(sessionId, error);
    }
  };
  const pump = (async () => {
    let backoff = 1_000;
    while (!stopped) {
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        iterator = ctx.event.subscribe()[Symbol.asyncIterator]();
        current = iterator;
        while (!stopped) {
          const next = await iterator.next();
          if (next.done === true) break;
          backoff = 1_000;
          handle(next.value);
        }
      } catch {
        // The host documents the event stream as volatile. Resubscribe below;
        // assistant text has no other boundary in this host.
      } finally {
        current = undefined;
        if (iterator !== undefined) {
          try {
            await iterator.return?.();
          } catch {
            // The stream is already gone; the next subscription starts clean.
          }
        }
      }
      if (stopped) return;
      await new Promise<void>((resolve) => {
        wake = setTimeout(resolve, backoff);
      });
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
  void pump;

  return async () => {
    stopped = true;
    if (wake !== undefined) clearTimeout(wake);
    try {
      await current?.return?.();
    } catch {
      // The pump is stopping either way; a stream that cannot close must not
      // leave the registrations and stores open.
    }
    for (const registration of registrations.splice(0).reverse()) {
      await registration.dispose();
    }
    sidecars.close();
  };
}

export interface RuntimeOptions extends ProjectionOptions {
  readonly enabled: boolean;
  readonly sidecarDir: string;
  readonly assembly: boolean;
  readonly readerTimeoutMs: number;
  readonly healSourceTokens?: number;
  readonly summarizerTokensPerCall: number;
  readonly summarizerTokensPerPass: number;
  readonly summarizerTokensPerHeal: number;
}

export function readOptions(raw: unknown): RuntimeOptions {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const summarizer = readSummarizer(record.summarizer);
  const smartZone = positiveNumber(record.smartZone);
  const swapAtRatio = readRatio(record.swapAtRatio) ?? DEFAULT_SWAP_RATIO;
  const recutAtRatio = readRatio(record.recutAtRatio) ?? DEFAULT_RECUT_RATIO;
  const zones = readZones(record.zones);
  const healSourceTokens = readHealSourceTokens(record.healSourceTokens);
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    sidecarDir: typeof record.sidecarDir === "string" ? record.sidecarDir : DEFAULT_SIDECAR_DIR,
    assembly: record.assembly !== false,
    swapAtRatio,
    recutAtRatio,
    keepRecentTokens: positiveInteger(record.keepRecentTokens) ?? DEFAULT_KEEP_RECENT_TOKENS,
    summaryTokens: positiveInteger(record.summaryTokens) ?? DEFAULT_SUMMARY_TOKENS,
    ...(healSourceTokens === undefined ? {} : { healSourceTokens }),
    contextWindow: positiveInteger(record.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    readerTimeoutMs: positiveInteger(record.readerTimeoutMs) ?? DEFAULT_READER_TIMEOUT_MS,
    summarizerTokensPerCall:
      positiveInteger(record.summarizerTokensPerCall) ?? SUMMARIZER_CALL_TOKENS,
    summarizerTokensPerPass:
      positiveInteger(record.summarizerTokensPerPass) ?? SUMMARIZER_PASS_TOKENS,
    summarizerTokensPerHeal:
      positiveInteger(record.summarizerTokensPerHeal) ?? SUMMARIZER_HEAL_TOKENS,
    ...(summarizer === undefined ? {} : { summarizer }),
    ...(smartZone === undefined ? {} : { smartZone }),
    ...(zones === undefined ? {} : { zones }),
  };
}

function readSummarizer(raw: unknown): string | string[] | undefined {
  if (typeof raw === "string") return raw.trim().length === 0 ? undefined : raw;
  if (!Array.isArray(raw)) return undefined;
  const chain = raw.filter((entry): entry is string => typeof entry === "string");
  return chain.length === 0 ? undefined : chain;
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function positiveInteger(raw: unknown): number | undefined {
  const value = positiveNumber(raw);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

/** A source window above the hard ceiling is a malformed override, not a
 * request for a prompt the summarizer call cap cannot carry. Falling back to
 * the derived default is safer than clamping a typo into a paid call. */
function readHealSourceTokens(raw: unknown): number | undefined {
  const value = positiveInteger(raw);
  return value !== undefined && value <= HEAL_SOURCE_MAX_TOKENS ? value : undefined;
}

/** A share of the window: above zero and at most one. Anything else keeps the
 * default rather than throwing, the way the other options read. */
function readRatio(raw: unknown): number | undefined {
  const value = positiveNumber(raw);
  return value !== undefined && value <= 1 ? value : undefined;
}

function readZones(raw: unknown): Record<string, ThresholdConfig> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const zones: Record<string, ThresholdConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const smartZone = positiveInteger(record.smartZone);
    const swapAtRatio = readRatio(record.swapAtRatio);
    const swapAtTokens = positiveInteger(record.swapAtTokens);
    const recutAtRatio = readRatio(record.recutAtRatio);
    const recutAtTokens = positiveInteger(record.recutAtTokens);
    if (
      smartZone === undefined &&
      swapAtRatio === undefined &&
      swapAtTokens === undefined &&
      recutAtRatio === undefined &&
      recutAtTokens === undefined
    ) {
      continue;
    }
    zones[key] = {
      ...(smartZone === undefined ? {} : { smartZone }),
      ...(swapAtRatio === undefined ? {} : { swapAtRatio }),
      ...(swapAtTokens === undefined ? {} : { swapAtTokens }),
      ...(recutAtRatio === undefined ? {} : { recutAtRatio }),
      ...(recutAtTokens === undefined ? {} : { recutAtTokens }),
    };
  }
  return Object.keys(zones).length === 0 ? undefined : zones;
}

/** The model the session last ran under, read from the stored messages so the
 * pass needs no extra host call. A model switch or a compaction carries one,
 * and an assistant message carries the one it answered with. */
function sessionModel(messages: readonly SessionMessageInfo[]): ModelRef | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const model = messages[index]?.model;
    if (model === undefined) continue;
    if (model.providerID.length === 0 || model.id.length === 0) continue;
    return {
      providerID: model.providerID,
      id: model.id,
      ...(model.variant === undefined ? {} : { variant: model.variant }),
    };
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plugin definition the host loads. Options come from the config entry,
 * so the default export reads them late, at setup time. The setup parameter
 * is the local context subset; the host's richer context satisfies it, which
 * `test/host-compat.test.ts` pins against the real host types. */
const definition = {
  id: PLUGIN_ID,
  setup: (ctx: OpencodeContext) => setupOpencodeLossless(ctx, ctx.options),
};

export default definition;
