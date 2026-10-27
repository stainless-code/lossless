import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEAL_SOURCE_MAX_TOKENS,
  SUMMARIZER_CALL_TOKENS,
  SUMMARIZER_PASS_TOKENS,
  createWindowLookup,
  LcmStore,
  makeLlm,
  makeRedactConfigAdapter,
  packageVersionNear,
  runHeal,
  type LlmComplete,
  type MetricsSink,
  type ThresholdConfig,
} from "lossless-core";

import { statusCommand, statusLine, passCommand, reportCommand } from "./command.ts";
import { createCheckpointWriter } from "./compaction.ts";
import { createContextProjector, type ProjectionOptions } from "./context.ts";
import { defaultSidecarDir, FALLBACK_SIDECAR_DIR } from "./default-sidecar-dir.ts";
import type { ModelRef, OpencodeContext, Registration, SessionMessageInfo } from "./host.ts";
import { compactionMark, mirror, mirrorBusEvent, toolEntry, userEntry } from "./ingest.ts";
import {
  backupCommand,
  diagnoseCommand,
  dumpCommand,
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

export const PLUGIN_ID = "opencode-lossless";

export interface OpencodeLosslessOptions {
  /** @default true */
  readonly enabled?: boolean;
  /** @default global sidecar dir, `./.lossless` only as fallback */
  readonly sidecarDir?: string;
  /** @default true
   * @example { assembly: false } */
  readonly assembly?: boolean;
  /** @default "auto" */
  readonly summarizer?: string | string[];
  /** @default 60000 */
  readonly summarizerTokensPerCall?: number;
  /** @default 250000 */
  readonly summarizerTokensPerPass?: number;
  /** @default 120000 */
  readonly summarizerTokensPerHeal?: number;
  /** @default [] */
  readonly mechanicalTools?: readonly string[];
  /** @default 0.7 */
  readonly swapAtRatio?: number;
  /** @default 0.85 */
  readonly recutAtRatio?: number;
  /** @default unset */
  readonly smartZone?: number;
  readonly zones?: Readonly<Record<string, ThresholdConfig>>;
  /** @default 20000 */
  readonly keepRecentTokens?: number;
  /** @default 1500 */
  readonly summaryTokens?: number;
  /** @default 8 x summaryTokens, clamped 3000..24000 */
  readonly healSourceTokens?: number;
  /** @default 128000 */
  readonly contextWindow?: number;
  /** @default 120000 */
  readonly readerTimeoutMs?: number;
}

const DEFAULT_SWAP_RATIO = 0.7;
const DEFAULT_RECUT_RATIO = 0.85;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_SUMMARY_TOKENS = 1500;
const DEFAULT_CONTEXT_WINDOW = 128_000;

export function pluginVersion(): string {
  return (
    packageVersionNear(fileURLToPath(import.meta.url), "opencode-lossless") ??
    "unknown (no package.json)"
  );
}

export function pluginLabel(): string {
  return `opencode-lossless ${pluginVersion()}`;
}

export async function setupOpencodeLossless(
  ctx: OpencodeContext,
  rawOptions?: unknown,
): Promise<() => Promise<void>> {
  const options = readOptions(rawOptions);
  if (options.enabled === false) return async () => undefined;
  logSidecarDir(options.sidecarDir, options.sidecarSource);
  const redact = makeRedactConfigAdapter(options);
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
    redact,
    timeoutMs: options.readerTimeoutMs,
  });
  const checkpoint = options.assembly
    ? createCheckpointWriter({ ctx, options, sidecars, windowOf })
    : undefined;

  registrations.push(
    await ctx.session.hook("prompt", (event) => {
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
        store: (sessionId) =>
          sessionId === undefined ? undefined : sidecars.peek(reader.storeSession(sessionId)),
        redact,
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
                summaries: stats.summaries,
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
          sidecarSource: options.sidecarSource,
          swapAtRatio: options.swapAtRatio,
          recutAtRatio: options.recutAtRatio,
          keepRecentTokens: options.keepRecentTokens,
          ...(options.smartZone === undefined ? {} : { smartZone: options.smartZone }),
          ...summarizerConfig(options),
          summarizerTokensPerHeal: options.summarizerTokensPerHeal,
          ...(options.zones === undefined ? {} : { zones: options.zones }),
          ...(options.mechanicalTools === undefined
            ? {}
            : { mechanicalTools: options.mechanicalTools }),
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
          // A heal can outlive the plugin instance that started it. The host
          // reloads plugins on watched-file changes and closes sidecars, so the run
          // owns a separate connection for its duration.
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
            redact,
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
        dumpCommand,
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
        // The reader child gets its instructions as the only system part.
        // The agent prompt and the parent projection stay out.
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
                  summarizer: {
                    ...summarizerConfig(options),
                    ...(options.mechanicalTools === undefined
                      ? {}
                      : { mechanicalTools: options.mechanicalTools }),
                  },
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
        // The host documents the event stream as volatile. Resubscribe below.
        // Assistant text has no other boundary in this host.
      } finally {
        current = undefined;
        if (iterator !== undefined) {
          try {
            await iterator.return?.();
          } catch {}
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
    } catch {}
    for (const registration of registrations.splice(0).reverse()) {
      await registration.dispose();
    }
    sidecars.close();
  };
}

export interface RuntimeOptions extends ProjectionOptions {
  readonly enabled: boolean;
  readonly sidecarDir: string;
  readonly sidecarSource: string;
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
  const mechanicalTools = readMechanicalTools(record.mechanicalTools);
  const sidecar = readSidecarDir(record.sidecarDir);
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    sidecarDir: sidecar.dir,
    sidecarSource: sidecar.source,
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
    ...(mechanicalTools === undefined ? {} : { mechanicalTools }),
  };
}

function readSidecarDir(raw: unknown): { dir: string; source: string } {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return { dir: raw, source: "explicit" };
  }
  const resolved = defaultSidecarDir();
  return { dir: resolved.dir, source: resolved.source };
}

function logSidecarDir(dir: string, source: string): void {
  try {
    console.log(`LCM sidecar dir: ${dir} (${source})`);
  } catch {}
  if (source === "explicit" || source === "fallback") return;
  try {
    if (resolve(FALLBACK_SIDECAR_DIR) === resolve(dir)) return;
    const entries = readdirSync(FALLBACK_SIDECAR_DIR);
    if (entries.length === 0) return;
    console.warn(
      `LCM sidecar: legacy ${resolve(FALLBACK_SIDECAR_DIR)} holds ${entries.length} file(s) ` +
        `and is not read. Sidecars now live in ${dir} (${source}). Nothing was moved. ` +
        `To keep the old dir set sidecarDir to "./.lossless". See /lossless-migrate.`,
    );
  } catch {}
}

function readSummarizer(raw: unknown): string | string[] | undefined {
  if (typeof raw === "string") return raw.trim().length === 0 ? undefined : raw;
  if (!Array.isArray(raw)) return undefined;
  const chain = raw.filter((entry): entry is string => typeof entry === "string");
  return chain.length === 0 ? undefined : chain;
}

function readMechanicalTools(raw: unknown): string[] | undefined {
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
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function positiveInteger(raw: unknown): number | undefined {
  const value = positiveNumber(raw);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

/** Above the call cap a value is a typo, not a paid call. Fall back instead of clamping. */
function readHealSourceTokens(raw: unknown): number | undefined {
  const value = positiveInteger(raw);
  return value !== undefined && value <= HEAL_SOURCE_MAX_TOKENS ? value : undefined;
}

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

const definition = {
  id: PLUGIN_ID,
  setup: (ctx: OpencodeContext) => setupOpencodeLossless(ctx, ctx.options),
};

export default definition;
