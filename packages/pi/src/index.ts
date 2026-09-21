import { createHash } from "node:crypto";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { lcmHomePath } from "lossless-core";
import { LcmStore, normalizeRole } from "lossless-core";
import {
  ingestEntries,
  entryToText,
  isIngestible,
  nextIngestWatermark,
  payloadOf,
  computeRawIngestDelta,
  type IngestStats,
  type IngestWatermark,
  type IngestibleEntry,
} from "lossless-core";
import { runCompaction } from "lossless-core";
import { makeLlm, resetSummarizerState } from "lossless-core";
import { cutIndexFor, buildSynthetic, contextChars, type AlignedEntry } from "lossless-core";
import {
  CALIBRATION_SAMPLE_CAP,
  calibrate,
  scaledBudget,
  STALE_REPORT_SHARE,
  tokensFromChars,
  type EstimateSample,
} from "lossless-core";
import {
  nextAction,
  cutMayReplace,
  effectiveThresholds,
  mergeZone,
  thresholdConflicts,
  type CommitState,
} from "lossless-core";
import { windowFromError } from "lossless-core";
import { WINDOW_SOURCE_PROVIDER } from "lossless-core";
import { appendMetric, usageRecord, type MetricSpan } from "lossless-core";
import {
  applyContextPolicy,
  resolveCompactionSpan,
  shouldKickBoundary,
  type FailedBoundary,
} from "lossless-core";
import { makeRedact } from "lossless-core";

import { piModelHost, piModelKey, piReader } from "./host.ts";
import {
  createGrepTool,
  createDescribeTool,
  createExpandQueryTool,
  type SessionRoots,
} from "./tools/recall.ts";
import { registerLcmCommand } from "./ui/command.ts";
import {
  type LcmConfig,
  readLcmConfig,
  writeLcmConfig,
  DEFAULT_CONFIG,
  passConditions,
  staleReason,
} from "./ui/config-io.ts";

let store: LcmStore | undefined;
let sessionPath = "";
let config: LcmConfig = {};
let commitState: CommitState | null = null;
let clampNotified = false;
let pinnedModelKey = "";
let pinnedWindow = 0;
let providerWindow: number | null = null;
let overflowFloor: number | null = null;
let storeGeneration = 0;
let ingestWatermark: IngestWatermark | null = null;
let sessionTag = "";
let sessionModelKey = "";
let sessionCharsPerToken: number | null = null;
let lastEstimateSample: { chars: number; tokens: number } | null = null;
const estimateSamples: EstimateSample[] = [];
let configProblems: string[] = [];
const failedBoundaries = new Map<string, FailedBoundary>();

function assertNever(outcome: never): undefined {
  throw new Error(`unhandled context outcome: ${JSON.stringify(outcome)}`);
}

function sessionRoots(): SessionRoots | undefined {
  if (sessionPath === "") return undefined;
  return {
    sessionsRoot: lcmHomePath("sessions"),
    storesDir: lcmHomePath("lcm"),
    // Pi starts an extension in the session's working directory, and the header
    // of every session file records the same path, which is what the filter
    // compares against.
    cwd: process.cwd(),
    excludeHash: sessionPath.slice(sessionPath.lastIndexOf("/") + 1).replace(/\.db$/, ""),
  };
}

function lcmDataPath(sessionFile: string | undefined): string {
  if (sessionFile) {
    const h = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    return lcmHomePath("lcm", `${h}.db`);
  }
  const h = createHash("sha256").update(`ephemeral:${process.cwd()}`).digest("hex").slice(0, 16);
  return lcmHomePath("lcm", `scratch-${h}.db`);
}

function openStore(): LcmStore | undefined {
  if (sessionPath === "") return undefined;
  store ??= new LcmStore(sessionPath);
  if (sessionCharsPerToken === null && sessionModelKey !== "") {
    sessionCharsPerToken = store.getModelState(sessionModelKey)?.charsPerToken ?? null;
  }
  // The same read for the window a provider stated earlier: Pi's belief is wrong
  // in the state that produced it, and the correction outlives the session.
  if (providerWindow === null && sessionModelKey !== "") {
    providerWindow = store.getModelState(sessionModelKey)?.contextWindow ?? null;
  }
  return store;
}

function sampleEstimate(chars: number, reported: number, target: LcmStore | undefined): void {
  const previous = lastEstimateSample;
  lastEstimateSample = { chars, tokens: reported };
  if (!previous || sessionModelKey === "") return;
  const charsGrown = chars - previous.chars;
  const tokensGrown = reported - previous.tokens;
  if (charsGrown <= 0 || tokensGrown <= 0) return;
  estimateSamples.push({ chars: charsGrown, tokens: tokensGrown });
  if (estimateSamples.length > CALIBRATION_SAMPLE_CAP) estimateSamples.shift();
  const charsPerToken = calibrate(estimateSamples);
  target?.setModelState(sessionModelKey, { charsPerToken, samples: estimateSamples.length });
  appendMetric({
    event: "lcm",
    kind: "estimate-calibrated",
    session: sessionTag,
    chars: charsGrown,
    tokens: tokensGrown,
    charsPerToken,
    samples: estimateSamples.length,
  });
}

function patchConfig(patch: Partial<LcmConfig>): void {
  config = { ...config, ...patch };
  try {
    writeLcmConfig(config);
  } catch {}
}

function activeEntryIds(
  sessionManager: { getBranch(fromId?: string): SessionEntry[] },
  leafId: string | null,
): Set<string> {
  return new Set((leafId === null ? [] : sessionManager.getBranch(leafId)).map((e) => e.id));
}

function reconcileBranch(
  sessionManager: { getBranch(fromId?: string): SessionEntry[] },
  oldLeafId: string | null,
  newLeafId: string | null,
): { removed: number; restored: number } {
  const db = store;
  if (!db) return { removed: 0, restored: 0 };
  const next = activeEntryIds(sessionManager, newLeafId);
  const previous = activeEntryIds(sessionManager, oldLeafId);
  const restored = db.setRemoved([...next], null);
  const removed = db.setRemoved(
    [...previous].filter((id) => !next.has(id)),
    Date.now(),
  );
  return { removed, restored };
}

const FILE_PATH_ARGS = ["path", "file_path", "filePath"] as const;

function namedPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of FILE_PATH_ARGS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toolCallPath(block: unknown): { id: string; path: string } | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as Record<string, unknown>;
  if (b.type !== "toolCall" && b.type !== "tool_use") return undefined;
  if (typeof b.id !== "string" || b.id.length === 0) return undefined;
  const path = namedPath(b.arguments ?? b.input);
  return path === undefined ? undefined : { id: b.id, path };
}

function collectMessageEntries(entries: readonly SessionEntry[]): AlignedEntry[] {
  const paths = new Map<string, string>();
  for (const e of entries) {
    for (const m of sessionEntryToContextMessages(e)) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        const call = toolCallPath(block);
        if (call) paths.set(call.id, call.path);
      }
    }
  }
  const out: AlignedEntry[] = [];
  for (const e of entries) {
    for (const m of sessionEntryToContextMessages(e)) {
      const payload = messagePayloadOf(m);
      const hint = m.role === "toolResult" ? paths.get(m.toolCallId) : undefined;
      out.push({
        entryId: e.id,
        role: m.role,
        text: contextMessageText(m),
        ...(payload === undefined ? {} : { payload }),
        ...(hint === undefined ? {} : { fileHint: { path: hint } }),
      });
    }
  }
  return out;
}

function externalizePolicy(): { largeFileChars: number } | undefined {
  if (config.externalizeFiles === false) return undefined;
  return { largeFileChars: config.largeFileChars ?? 32_000 };
}

function recordIngestStats(stats: IngestStats): void {
  for (const f of stats.files) {
    appendMetric({
      event: "lcm",
      kind: "file-externalized",
      session: sessionTag,
      entryId: f.entryId,
      fileId: f.fileId,
      path: f.path,
      fileKind: f.kind,
      bytes: f.bytes,
    });
  }
  for (const l of stats.largeInline) {
    appendMetric({
      event: "lcm",
      kind: "large-inline",
      session: sessionTag,
      entryId: l.entryId,
      chars: l.chars,
    });
  }
}

function messagePayloadOf(
  m: ReturnType<typeof sessionEntryToContextMessages>[number],
): string | undefined {
  switch (m.role) {
    case "bashExecution":
    case "branchSummary":
    case "compactionSummary":
      return undefined;
    default:
      return payloadOf(m.content);
  }
}

function toIngestible(e: AlignedEntry): IngestibleEntry {
  return {
    entryId: e.entryId,
    role: normalizeRole(e.role),
    text: e.text,
    timestamp: Date.now(),
    ...(e.payload === undefined ? {} : { payload: e.payload }),
    ...(e.fileHint === undefined ? {} : { fileHint: e.fileHint }),
    piCompaction: e.role === "compactionSummary",
  };
}

function contextMessageText(m: ReturnType<typeof sessionEntryToContextMessages>[number]): string {
  switch (m.role) {
    case "bashExecution":
      return `$ ${m.command}\n${m.output}`;
    case "branchSummary":
    case "compactionSummary":
      return m.summary;
    default:
      return entryToText(m.content);
  }
}

function recordPiCompactions(
  entryIds: readonly string[],
  usage: { tokens: number | null; contextWindow: number } | undefined,
): void {
  for (const entryId of entryIds) {
    appendMetric({
      event: "lcm",
      kind: "pi-compaction",
      session: sessionTag,
      entryId,
      ...(typeof usage?.tokens === "number" ? { tokens: usage.tokens } : {}),
      ...(usage === undefined ? {} : { window: usage.contextWindow }),
    });
  }
}

export default function (pi: ExtensionAPI) {
  const loaded = readLcmConfig();
  config = loaded.config;
  configProblems = loaded.problems;
  const redact = makeRedact(() => config);

  const getStore = () => store;
  const keepRecent = () => scaledBudget(config.keepRecentTokens ?? 20_000, sessionCharsPerToken);

  pi.on("session_start", async (_event, ctx) => {
    storeGeneration++;
    ingestWatermark = null;
    failedBoundaries.clear();
    clampNotified = false;
    pinnedModelKey = "";
    pinnedWindow = 0;
    providerWindow = null;
    overflowFloor = null;
    resetSummarizerState();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    sessionPath = lcmDataPath(sessionFile);
    sessionTag = sessionPath.split("/").pop() ?? "";
    sessionModelKey = piModelKey(ctx);
    sessionCharsPerToken = null;
    lastEstimateSample = null;
    estimateSamples.length = 0;
    store?.close();
    store = undefined;
    if (configProblems.length > 0) {
      if (ctx.hasUI) {
        ctx.ui.notify(configProblems.map((p) => `LCM: lcm.json ${p}`).join("\n"), "warning");
      } else {
        appendMetric({
          event: "lcm",
          kind: "config-problem",
          problems: configProblems,
          session: sessionTag,
        });
      }
    }
    const entries = ctx.sessionManager.getEntries();
    const collected = collectMessageEntries(entries);
    const ingestible = collected.map(toIngestible);
    const opened = ingestible.some(isIngestible) ? openStore() : undefined;
    if (opened) {
      const stats = ingestEntries(opened, ingestible, {
        externalize: externalizePolicy(),
      });
      recordIngestStats(stats);
      recordPiCompactions(stats.piCompactions, ctx.getContextUsage?.());
    }
    ingestWatermark = nextIngestWatermark(collected);
    if (opened) {
      const activeIds = activeEntryIds(ctx.sessionManager, ctx.sessionManager.getLeafId());
      const abandoned = entries.filter((e) => !activeIds.has(e.id)).map((e) => e.id);
      if (abandoned.length > 0) opened.setRemoved(abandoned, Date.now());
    }
    if (ctx.hasUI) {
      for (const w of thresholdConflicts(config)) ctx.ui.notify(w, "warning");
      const mk = piModelKey(ctx);
      const z = config.zones?.[mk];
      if (z) for (const w of thresholdConflicts(z, `zones["${mk}"]`)) ctx.ui.notify(w, "warning");
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    if (!store) return;
    const { removed, restored } = reconcileBranch(
      ctx.sessionManager,
      event.oldLeafId,
      event.newLeafId,
    );
    if (removed > 0 || restored > 0) {
      appendMetric({
        event: "lcm",
        kind: "branch-removed",
        session: sessionTag,
        removed,
        restored,
      });
    }
  });

  pi.on("session_shutdown", async () => {
    storeGeneration++;
    ingestWatermark = null;
    failedBoundaries.clear();
    store?.close();
    store = undefined;
    sessionPath = "";
    commitState = null;
  });

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    const named = windowFromError(event.message.errorMessage);
    if (named !== null && named !== providerWindow) {
      providerWindow = named;
      if (store && sessionModelKey !== "") {
        store.setModelWindow(sessionModelKey, named, WINDOW_SOURCE_PROVIDER);
      }
      appendMetric({
        event: "lcm",
        kind: "window-corrected",
        session: sessionTag,
        model: sessionModelKey,
        window: named,
        source: WINDOW_SOURCE_PROVIDER,
      });
    }
    const record = usageRecord(event.message.usage);
    if (record) appendMetric({ ...record, session: sessionTag });
  });

  pi.on("turn_end", async (event, ctx) => {
    const raw = ctx.sessionManager.getEntries();
    const probe = computeRawIngestDelta(raw, ingestWatermark);
    const delta = collectMessageEntries(probe.reset ? raw : raw.slice(probe.startIndex));
    const ingestible = delta.map(toIngestible);
    const opened = ingestible.some(isIngestible) ? openStore() : undefined;
    if (opened) {
      const stats = ingestEntries(opened, ingestible, {
        externalize: externalizePolicy(),
      });
      recordIngestStats(stats);
      recordPiCompactions(stats.piCompactions, ctx.getContextUsage?.());
    }
    ingestWatermark = nextIngestWatermark(delta) ?? ingestWatermark;
    if (ctx.hasUI && store) {
      const s = store.stats();
      ctx.ui.setWidget("lcm", [
        `lcm: ${s.messages} msgs · ${s.summaries} summaries · ${(s.dbBytes / 1024).toFixed(0)} KB`,
      ]);
    }
    void event;
  });

  pi.on("context", async (event, ctx) => {
    if (!store || config.assemblyEnabled === false) return;
    const db = store;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null || !usage.contextWindow) return;
    const effectiveWindow = Math.min(
      usage.contextWindow,
      providerWindow ?? Number.POSITIVE_INFINITY,
      overflowFloor ?? Number.POSITIVE_INFINITY,
    );
    // One turn, and this is the turn: Pi retries the refused request after
    // compacting, and a floor that outlived its retry would tax every later turn.
    overflowFloor = null;
    const chars = contextChars(event.messages);
    // a calibration sample either, because calibrating the estimator against itself
    // would poison the ratio it is read with.
    const estimated = tokensFromChars(chars);
    const stale = estimated > 0 && usage.tokens / estimated < STALE_REPORT_SHARE;
    const tokens = stale ? estimated : usage.tokens;
    const occupancy = tokens / effectiveWindow;
    if (!stale) sampleEstimate(chars, usage.tokens, db);
    const mk = piModelKey(ctx);
    const zone = config.zones?.[mk];
    const merged = mergeZone(config, zone);

    const result = applyContextPolicy(
      {
        rawMessages: event.messages,
        getCtxEntries: () => collectMessageEntries(ctx.sessionManager.buildContextEntries()),
        occupancy,
        tokens,
        tokensEstimated: stale ? true : undefined,
        contextWindow: usage.contextWindow,
        thresholdWindow: effectiveWindow,
        modelKey: mk,
        zone: zone ? mk : undefined,
        thresholds: merged,
        keepRecentTokens: keepRecent(),
        summaryTokens: scaledBudget(config.summaryTokens ?? 1500, sessionCharsPerToken),
        clampNotified,
        commitState,
        pinnedModelKey,
        pinnedWindow,
      },
      {
        thresholds: effectiveThresholds,
        nextAction,
        cutIndexFor,
        cutMayReplace,
        frontier: (firstEntryId, lastEntryId) => {
          const nodes = db.frontier(firstEntryId, lastEntryId);
          if (nodes[nodes.length - 1]?.lastEntryId === lastEntryId) {
            failedBoundaries.delete(lastEntryId);
          }
          return nodes;
        },
        spanBounds: (aged) => db.spanBounds(aged.map((entry) => entry.entryId)),
        buildSynthetic,
        redact,
      },
    );

    commitState = result.commitState;
    pinnedModelKey = result.pinnedModelKey;
    pinnedWindow = result.pinnedWindow;
    clampNotified = result.clampNotified;
    for (const m of result.metrics) appendMetric({ ...m, session: sessionTag });
    if (result.clampWarning && ctx.hasUI) ctx.ui.notify(result.clampWarning, "warning");

    switch (result.outcome) {
      case "quiet":
        return;
      case "swap":
      case "reapply":
        return { messages: result.messages as AgentMessage[] };
      case "bail":
      case "kick": {
        appendMetric({
          event: "lcm",
          kind: "swap-blocked",
          session: sessionTag,
          reason: result.reason,
          occupancy: Math.round(occupancy * 1000) / 1000,
          tokens,
        });
        if (result.outcome === "kick") {
          const boundary = result.span.lastEntryId;
          if (shouldKickBoundary(failedBoundaries.get(boundary), Date.now())) {
            const latch = failedBoundaries.get(boundary);
            failedBoundaries.set(boundary, {
              attempts: (latch?.attempts ?? 0) + 1,
              lastAt: Date.now(),
            });
            kickAsyncCompaction(ctx, branchOrdered(ctx, result.aged));
          } else {
            appendMetric({
              event: "lcm",
              kind: "swap-blocked",
              session: sessionTag,
              reason: "kick-backoff",
              entryId: boundary,
              occupancy: Math.round(occupancy * 1000) / 1000,
            });
          }
        }
        if (result.messages) return { messages: result.messages as AgentMessage[] };
        return;
      }
      default:
        return assertNever(result);
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (event.reason === "overflow") {
      overflowFloor = event.preparation.tokensBefore;
      appendMetric({
        event: "lcm",
        kind: "window-floor",
        session: sessionTag,
        tokens: event.preparation.tokensBefore,
        window: providerWindow,
      });
    }
    if (!store) return;
    try {
      const { preparation, branchEntries } = event;
      const previousCompaction = branchEntries.findLast((e) => e.type === "compaction");
      const branchMsgs = collectMessageEntries(branchEntries);
      const effectiveSpan = resolveCompactionSpan(branchMsgs, {
        startEntryId: previousCompaction?.firstKeptEntryId,
        firstKeptEntryId: preparation.firstKeptEntryId,
      });
      if (effectiveSpan.length === 0) return;

      const firstSpanEntry = effectiveSpan[0];
      const lastSpanEntry = effectiveSpan[effectiveSpan.length - 1];
      if (!firstSpanEntry || !lastSpanEntry) return;
      const llm = makeLlm(piModelHost(ctx), config, {
        session: sessionTag,
        stage: "blocking",
        span: { firstEntryId: firstSpanEntry.entryId, lastEntryId: lastSpanEntry.entryId },
      });
      if (!llm) return; // falls back to Pi default; makeLlm recorded why

      await awaitPassInFlight();

      const outcome = await (async () => {
        const { token, dropped } = store.openRun({ session: sessionTag });
        try {
          const result = await runCompaction(
            store.forRun(token),
            {
              span: effectiveSpan.map((e) => ({
                entryId: e.entryId,
                role: normalizeRole(e.role),
                text: e.text,
                ...(e.payload === undefined ? {} : { payload: e.payload }),
              })),
              previousSummary: preparation.previousSummary,
              targetTokens: scaledBudget(config.summaryTokens ?? 1500, sessionCharsPerToken),
              frontierFrom: branchMsgs[0]?.entryId,
            },
            llm,
            {
              leafChunkTokens: scaledBudget(config.leafChunkTokens ?? 3000, sessionCharsPerToken),
              redact,
              session: sessionTag,
              stage: "blocking",
            },
          );
          const closed = store.commitRun(token);
          if (dropped + closed.dropped > 0) {
            appendMetric({
              event: "lcm",
              kind: "compaction-abandoned",
              session: sessionTag,
              stage: "blocking",
              dropped: dropped + closed.dropped,
            });
          }
          return result;
        } finally {
          store.abandonRun(token);
        }
      })();

      commitState = null;
      if (outcome.kind === "nothing") {
        appendMetric({
          event: "lcm",
          kind: "compaction-noop",
          stage: "blocking",
          session: sessionTag,
          reason: outcome.reason,
          ingested: outcome.ingested,
          span: [firstSpanEntry.entryId, lastSpanEntry.entryId],
        });
      }
      if (outcome.kind === "stored" && ctx.hasUI) {
        const leaves = outcome.leafSummaryIds.length;
        const condensed = outcome.condensedSummaryIds.length;
        if (leaves + condensed > 0) {
          ctx.ui.notify(
            `LCM compaction: ${outcome.ingested} messages → ${leaves} leaf + ${condensed} condensed summaries`,
            "info",
          );
        }
      }
      const summary = outcome.kind === "stored" ? outcome.summaryText : preparation.previousSummary;
      if (!summary) return;
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch (error) {
      appendMetric({
        event: "lcm",
        kind: "compaction-error",
        stage: "blocking",
        session: sessionTag,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        spanEnd: event.preparation.firstKeptEntryId,
      });
      return undefined;
    }
  });

  let passInFlight: Promise<unknown> | null = null;
  let passStartedAt = 0;
  let passToken = 0;
  let pendingPass: {
    aged: AlignedEntry[];
    session: string;
    generation: number;
    queued: number;
    ctx: ExtensionContext;
  } | null = null;
  const HUNG_CALL_SLOT_TTL_MS = 5 * 60_000;
  const PASS_AWAIT_TIMEOUT_MS = 20_000;

  async function awaitPassInFlight(): Promise<void> {
    const pass = passInFlight;
    if (!pass) return;
    const started = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pass.then(
        () => {},
        () => {},
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, PASS_AWAIT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    appendMetric({
      event: "lcm",
      kind: "compaction-awaited",
      session: sessionTag,
      elapsedMs: Date.now() - started,
      timedOut,
    });
  }

  function startPass(ctx: ExtensionContext, aged: AlignedEntry[]): void {
    const db = store;
    const lastAged = aged[aged.length - 1];
    if (!db || !lastAged) return;
    const span: MetricSpan = [(aged[0] ?? lastAged).entryId, lastAged.entryId];
    const llm = makeLlm(piModelHost(ctx), config, {
      session: sessionTag,
      stage: "async",
      span: { firstEntryId: span[0], lastEntryId: span[1] },
    });
    if (!llm) return;
    const generation = storeGeneration;
    const { token: runToken, dropped: reaped } = db.openRun({ session: sessionTag });
    const token = ++passToken;
    const conditions = passConditions(config);
    const kickedUnder = piModelKey(ctx);
    passStartedAt = Date.now();
    // Deliberately NOT bound to ctx.signal: this must survive the turn.
    passInFlight = runCompaction(
      db.forRun(runToken),
      {
        span: aged.map((e) => ({
          entryId: e.entryId,
          role: normalizeRole(e.role),
          text: e.text,
          ...(e.payload === undefined ? {} : { payload: e.payload }),
        })),
        targetTokens: scaledBudget(conditions.summaryTokens, sessionCharsPerToken),
      },
      llm,
      {
        leafChunkTokens: scaledBudget(conditions.leafChunkTokens, sessionCharsPerToken),
        maxChunks: conditions.maxAsyncChunks,
        redact,
        session: sessionTag,
        stage: "async",
      },
    )
      .then((outcome) => {
        if (generation !== storeGeneration) return;
        if (outcome.kind === "nothing") {
          appendMetric({
            event: "lcm",
            kind: "compaction-noop",
            stage: "async",
            session: sessionTag,
            reason: outcome.reason,
            ingested: outcome.ingested,
            span,
          });
          return;
        }
        const stale = staleReason(
          { model: kickedUnder, settings: conditions },
          { model: pinnedModelKey, settings: passConditions(config) },
        );
        if (!stale) {
          const closed = db.commitRun(runToken);
          if (reaped + closed.dropped > 0) {
            appendMetric({
              event: "lcm",
              kind: "compaction-abandoned",
              session: sessionTag,
              stage: "async",
              dropped: reaped + closed.dropped,
            });
          }
          return;
        }
        const dropped = db.abandonRun(runToken);
        appendMetric({
          event: "lcm",
          kind: "compaction-stale",
          session: sessionTag,
          reason: stale.reason,
          changed: stale.changed,
          stage: "async",
          entryId: lastAged.entryId,
          span,
          dropped,
        });
      })
      .catch((error: unknown) => {
        if (generation !== storeGeneration) return;
        appendMetric({
          event: "lcm",
          kind: "compaction-error",
          stage: "async",
          session: sessionTag,
          entryId: lastAged.entryId,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
      })
      .finally(() => {
        db.abandonRun(runToken);
        if (token !== passToken) return;
        passInFlight = null;
        drainPendingPass();
      });
  }

  function drainPendingPass(): void {
    const pending = pendingPass;
    if (!pending) return;
    pendingPass = null;
    const lastAged = pending.aged[pending.aged.length - 1];
    if (!lastAged) return;
    if (!store || pending.generation !== storeGeneration) {
      appendMetric({
        event: "lcm",
        kind: "compaction-queued-dropped",
        session: pending.session,
        entryId: lastAged.entryId,
        reason: "store-reset",
      });
      return;
    }
    appendMetric({
      event: "lcm",
      kind: "compaction-queued",
      session: pending.session,
      entryId: lastAged.entryId,
      queued: pending.queued,
    });
    startPass(pending.ctx, pending.aged);
  }

  function clearHungPass(now: number): void {
    if (!passInFlight || now - passStartedAt < HUNG_CALL_SLOT_TTL_MS) return;
    passToken++;
    passInFlight = null;
    appendMetric({
      event: "lcm",
      kind: "compaction-timeout-cleared",
      session: sessionTag,
      elapsedMs: now - passStartedAt,
    });
  }

  function branchOrdered(ctx: ExtensionContext, aged: readonly AlignedEntry[]): AlignedEntry[] {
    const rank = new Map(ctx.sessionManager.getBranch().map((e, i) => [e.id, i]));
    return aged
      .map((entry, index) => ({ entry, key: rank.get(entry.entryId) ?? rank.size + index }))
      .sort((a, b) => a.key - b.key)
      .map(({ entry }) => entry);
  }

  function kickAsyncCompaction(ctx: ExtensionContext, aged: AlignedEntry[]): void {
    if (!store || aged.length === 0) return;
    clearHungPass(Date.now());
    if (passInFlight) {
      pendingPass = {
        aged,
        session: sessionTag,
        generation: storeGeneration,
        queued: (pendingPass?.queued ?? 0) + 1,
        ctx,
      };
      return;
    }
    startPass(ctx, aged);
  }

  pi.registerTool(
    createGrepTool({ store: getStore, session: () => sessionTag, redact, sessions: sessionRoots }),
  );
  pi.registerTool(createDescribeTool({ store: getStore, session: () => sessionTag, redact }));
  pi.registerTool(
    createExpandQueryTool({
      store: getStore,
      session: () => sessionTag,
      redact,
      sessions: sessionRoots,
      reader: (ctx, signal) => piReader(ctx, signal),
    }),
  );

  registerLcmCommand(pi, {
    getStore,
    openStore,
    getConfig: () => config,
    patchConfig,
    resetConfig: () => {
      config = { ...DEFAULT_CONFIG };
      configProblems = [];
      try {
        writeLcmConfig(config);
      } catch {}
      commitState = null;
    },
    clearCommitState: () => {
      commitState = null;
    },
    getCommitState: () => commitState,
    getDbPath: (sessionFile) => lcmDataPath(sessionFile),
    keepRecentTokens: keepRecent,
  });
}
