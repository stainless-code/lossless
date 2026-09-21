import { readFileSync } from "node:fs";

import { fmtTokens } from "./format.ts";
import { metricsLogFiles, type MetricRecord } from "./metrics.ts";

type Row = MetricRecord;
type KeysOf<T> = T extends unknown ? keyof T : never;
type ValueOf<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type AnyField = KeysOf<Row>;
type FieldOf<K extends AnyField> = ValueOf<Row, K>;
type RowFields = { [K in AnyField]?: FieldOf<K> };
type FieldsMatching<P> = { [K in AnyField]: [FieldOf<K>] extends [P] ? K : never }[AnyField];

export type MetricsEvent = RowFields & { ts?: number; [key: string]: unknown };

const NUMBER_FIELDS = [
  "ts",
  "occupancy",
  "tokens",
  "window",
  "soft",
  "commit",
  "summaryId",
  "cutCount",
  "appliedAtOccupancy",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "costInput",
  "costOutput",
  "costTotal",
  "sourceChars",
  "sourceTokens",
  "keptChars",
  "droppedChars",
  "hits",
  "id",
  "depth",
  "sessionsScanned",
  "sessionsSkipped",
  "fromGeneration",
  "toGeneration",
  "nodes",
  "renderedTokens",
  "budgetTokens",
  "spentTokens",
  "stubbed",
  "minDepth",
  "frontierTokens",
  "targetTokens",
  "cap",
  "messages",
  "attemptedTokens",
  "existingTokens",
  "beforeTokens",
  "afterTokens",
  "leaves",
  "condensed",
  "ingested",
  "elapsedMs",
  "queued",
  "sizeBytes",
  "bytes",
  "chars",
  "charsPerToken",
  "samples",
  "removed",
  "restored",
  "queryChars",
  "steps",
  "retrievedTokens",
  "maxTokens",
  "level",
  "messagesInserted",
  "messagesSkipped",
  "summariesInserted",
  "summariesSkipped",
  "dropped",
  "failedWalks",
  "seed",
  "needles",
  "passes",
  "depth",
  "fidelity",
  "fromProjection",
  "fromRecall",
  "failed",
  "surfaceTokens",
  "turns",
] as const;
const STRING_FIELDS = [
  "event",
  "kind",
  "action",
  "zone",
  "stage",
  "tool",
  "outcome",
  "stop",
  "reason",
  "scope",
  "refused",
  "db",
  "error",
  "exportedTo",
  "spanEnd",
  "stopReason",
  "model",
  "session",
  "entryId",
  "fileId",
  "path",
  "fileKind",
  "fingerprint",
  "category",
  "source",
] as const;
const BOOLEAN_FIELDS = [
  "committed",
  "distinctBoundary",
  "retried",
  "timedOut",
  "tokensEstimated",
] as const;

type AssertNever<T extends never> = T;
type Audit<Names extends readonly string[], Category, Extra extends string = never> =
  | Exclude<FieldsMatching<Category> | Extra, Names[number]>
  | Exclude<Names[number], AnyField | Extra>
  | { [K in Names[number]]: [ValueOf<Row, K>] extends [Category] ? never : K }[Names[number]];

type _NumericFields = AssertNever<Audit<typeof NUMBER_FIELDS, number | null | undefined, "ts">>;
type _StringFields = AssertNever<Audit<typeof STRING_FIELDS, string | undefined>>;
type _BooleanFields = AssertNever<Audit<typeof BOOLEAN_FIELDS, boolean | undefined>>;

function normalizeMetricsEvent(raw: Record<string, unknown>): MetricsEvent {
  const out: Record<string, unknown> = { ...raw };
  for (const key of NUMBER_FIELDS) {
    const v = out[key];
    if (v !== undefined && v !== null && !(typeof v === "number" && Number.isFinite(v))) {
      delete out[key];
    }
  }
  for (const key of STRING_FIELDS) {
    if (out[key] !== undefined && typeof out[key] !== "string") delete out[key];
  }
  for (const key of BOOLEAN_FIELDS) {
    if (out[key] !== undefined && typeof out[key] !== "boolean") delete out[key];
  }
  if (out.level !== undefined && typeof out.level !== "number" && typeof out.level !== "string") {
    delete out.level;
  }
  return out as MetricsEvent;
}

export function collectMetricsEvents(): MetricsEvent[] {
  const paths = metricsLogFiles();
  const events: MetricsEvent[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          events.push(normalizeMetricsEvent(parsed as Record<string, unknown>));
        }
      } catch {}
    }
  }
  return events;
}

export interface DepthStat {
  depth: number;
  count: number;
  totalTokens: number;
  avgTokens: number;
}

export function depthStats(summaries: readonly { depth: number; tokens: number }[]): DepthStat[] {
  const byDepth = new Map<number, { count: number; totalTokens: number }>();
  for (const s of summaries) {
    const row = byDepth.get(s.depth) ?? { count: 0, totalTokens: 0 };
    row.count++;
    row.totalTokens += s.tokens;
    byDepth.set(s.depth, row);
  }
  return [...byDepth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, { count, totalTokens }]) => ({
      depth,
      count,
      totalTokens,
      avgTokens: Math.round(totalTokens / count),
    }));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function dayOf(ts: number | undefined): string {
  return ts ? new Date(ts).toISOString().slice(0, 10) : "(unknown)";
}

export function buildReport(events: readonly MetricsEvent[]): string {
  const decisions = events.filter((e) => e.event === "lcm" && e.kind === "context-decision");
  const swaps = events.filter((e) => e.event === "lcm" && e.kind === "swap-applied");
  const usage = events.filter((e) => e.event === "usage");
  const branchRemoved = events.filter((e) => e.event === "lcm" && e.kind === "branch-removed");
  const health = events.filter(
    (e) =>
      e.event === "lcm" &&
      (e.kind === "summarizer-error" ||
        e.kind === "summarizer-capped" ||
        e.kind === "summarizer-fallback" ||
        e.kind === "summary-fallback-stored" ||
        e.kind === "compaction-error" ||
        e.kind === "compaction-stale" ||
        e.kind === "compaction-abandoned"),
  );

  const lines: string[] = ["# LCM metrics report", ""];
  const files = metricsLogFiles();
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    if (typeof e.ts !== "number") continue;
    if (e.ts < first) first = e.ts;
    if (e.ts > last) last = e.ts;
  }
  const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  lines.push(
    `${events.length} rows across ${files.length} ${files.length === 1 ? "file" : "files"}` +
      (Number.isFinite(first) ? `, ${stamp(first)} to ${stamp(last)} UTC` : "") +
      ". One generation is about a day, so the window this file holds is the window a reader can trust.",
    "",
  );

  const buckets = new Map<string, number>();
  let atOrAboveRecut = 0;
  for (const d of decisions) {
    const occ = typeof d.occupancy === "number" ? d.occupancy : 0;
    const bucket = Math.min(10, Math.floor(occ * 10));
    const label = bucket >= 10 ? "100%+" : `${bucket * 10}-${bucket * 10 + 10}%`;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
    if (typeof d.occupancy === "number" && typeof d.commit === "number" && occ >= d.commit) {
      atOrAboveRecut++;
    }
  }
  lines.push(
    `## Occupancy dwell (${decisions.length} decisions)`,
    "",
    "| bucket | decisions |",
    "| ------ | --------- |",
  );
  for (const [label, count] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${label} | ${count} |`);
  }
  lines.push(
    "",
    `At/above the recut line: ${atOrAboveRecut} of ${decisions.length} (${((atOrAboveRecut / Math.max(1, decisions.length)) * 100).toFixed(1)}%). Sustained values here mean the session lives past its own commit boundary.`,
    "",
  );

  // A boundary is a cut that had not been applied before; an application is a
  // committed projection, and one turn re-applies its boundary on every
  // request. The cut decides the count, since a cut never returns within a
  // session (`cutMayReplace` is monotone). The row's own `distinctBoundary` can
  // only lower it: a restarted process loses the pin and reports a cut the
  // session already applied. Spacing is per session.
  interface Cadence {
    applications: number;
    seen: Set<string>;
    stamps: number[];
  }
  const bySession = new Map<string, Cadence>();
  let boundaries = 0;
  for (const s of swaps) {
    const session = typeof s.session === "string" ? s.session : "(no session)";
    const row = bySession.get(session) ?? { applications: 0, seen: new Set<string>(), stamps: [] };
    row.applications++;
    const cut = String(s.cutCount ?? "(no cut)");
    const repeat = row.seen.has(cut) || s.distinctBoundary === false;
    row.seen.add(cut);
    if (!repeat) {
      row.stamps.push(s.ts ?? 0);
      boundaries++;
    }
    bySession.set(session, row);
  }
  lines.push(
    `## Swap cadence (${swaps.length} applications, ${boundaries} distinct ${boundaries === 1 ? "boundary" : "boundaries"})`,
    "",
  );
  if (swaps.length === 0) {
    lines.push("No swap applications recorded.", "");
  } else {
    lines.push(
      "| session | applications | boundaries | median min between boundaries |",
      "| ------- | ------------ | ---------- | ----------------------------- |",
    );
    const rows = [...bySession.entries()].sort(
      (a, b) => b[1].applications - a[1].applications || a[0].localeCompare(b[0]),
    );
    for (const [session, row] of rows) {
      const stamps = [...row.stamps].sort((a, b) => a - b);
      const gapsMin = [];
      for (let i = 1; i < stamps.length; i++) gapsMin.push((stamps[i]! - stamps[i - 1]!) / 60_000);
      lines.push(
        `| ${session} | ${row.applications} | ${row.stamps.length} | ${gapsMin.length > 0 ? median(gapsMin).toFixed(1) : "n/a"} |`,
      );
    }
    const repeats = swaps.length - boundaries;
    if (repeats > 0) {
      lines.push(
        "",
        `${repeats} of ${swaps.length} applications re-applied a boundary already served, which is the frozen cut holding for the turn that pinned it, not new compaction.`,
      );
    }
    lines.push("");
  }

  const firstSwapTs = swaps.reduce<number | undefined>(
    (acc, s) => (acc === undefined || (s.ts ?? 0) < acc ? (s.ts ?? 0) : acc),
    undefined,
  );
  const sums = (list: MetricsEvent[]) => {
    return {
      fresh: list.reduce((n, e) => n + (e.input ?? 0), 0),
      output: list.reduce((n, e) => n + (e.output ?? 0), 0),
      cacheRead: list.reduce((n, e) => n + (e.cacheRead ?? 0), 0),
      cacheWrite: list.reduce((n, e) => n + (e.cacheWrite ?? 0), 0),
      cost: list.reduce((n, e) => n + (e.costTotal ?? 0), 0),
      turns: list.length,
    };
  };
  const before = firstSwapTs === undefined ? usage : usage.filter((e) => (e.ts ?? 0) < firstSwapTs);
  const after = firstSwapTs === undefined ? [] : usage.filter((e) => (e.ts ?? 0) >= firstSwapTs);
  const row = (label: string, s: ReturnType<typeof sums>) =>
    `| ${label} | ${s.turns} | ${fmtTokens(s.fresh)} | ${fmtTokens(s.cacheRead)} | ${fmtTokens(s.cacheWrite)} | $${s.cost.toFixed(4)} |`;
  lines.push(
    `## Cache economics (C1, split at first swap)`,
    "",
    "| turn | fresh input | cacheRead | cacheWrite | cost |",
    "| ---- | ----------- | --------- | ---------- | ---- |",
    row("before first swap", sums(before)),
    row("after first swap", sums(after)),
    row("total", sums(usage)),
    "",
  );

  const summarizerUsage = events.filter((e) => e.event === "lcm" && e.kind === "summarizer-usage");
  if (summarizerUsage.length > 0) {
    const byKey = new Map<string, { model: string; stage: string; rows: MetricsEvent[] }>();
    for (const e of summarizerUsage) {
      const model = typeof e.model === "string" ? e.model : "(unrecorded)";
      const stage = typeof e.stage === "string" ? e.stage : "(unrecorded)";
      const key = `${model}|${stage}`;
      const group = byKey.get(key) ?? { model, stage, rows: [] };
      group.rows.push(e);
      byKey.set(key, group);
    }
    const total = sums(summarizerUsage);
    const rejected = summarizerUsage.filter((e) => e.outcome === "failure").length;
    lines.push(
      `## Summarizer spend (${summarizerUsage.length} provider calls, $${total.cost.toFixed(4)})`,
      "",
      "| model | stage | calls | fresh input | cacheRead | output | cost |",
      "| ----- | ----- | ----- | ----------- | --------- | ------ | ---- |",
    );
    for (const group of [...byKey.values()].sort(
      (a, b) => b.rows.length - a.rows.length || a.model.localeCompare(b.model),
    )) {
      const s = sums(group.rows);
      lines.push(
        `| ${group.model} | ${group.stage} | ${s.turns} | ${fmtTokens(s.fresh)} | ${fmtTokens(s.cacheRead)} | ${fmtTokens(s.output)} | $${s.cost.toFixed(4)} |`,
      );
    }
    lines.push(
      `| total | | ${total.turns} | ${fmtTokens(total.fresh)} | ${fmtTokens(total.cacheRead)} | ${fmtTokens(total.output)} | $${total.cost.toFixed(4)} |`,
      "",
    );
    const mainCost = sums(usage).cost;
    lines.push(
      mainCost > 0
        ? `Summarizer calls are ${((total.cost / mainCost) * 100).toFixed(1)}% of the $${mainCost.toFixed(4)} the session's own turns cost in this file.`
        : "No session-turn cost is recorded in this file to compare against.",
    );
    if (rejected > 0) {
      lines.push(
        `${rejected} of ${summarizerUsage.length} calls were rejected by the provider (a length or error stop), and their tokens are included above.`,
      );
    }
    lines.push("");
  }

  // The publish-gate question is whether the `[lcm:*]` pointers in a
  // projection get exercised. A call before the session's first swap read the
  // raw tail rather than a pointer, so the two are counted apart.
  const recall = events.filter((e) => e.event === "lcm" && e.kind === "recall");
  if (recall.length > 0) {
    const firstSwap = new Map<string, number>();
    for (const s of swaps) {
      const session = typeof s.session === "string" ? s.session : "(no session)";
      const ts = s.ts ?? 0;
      const seen = firstSwap.get(session);
      if (seen === undefined || ts < seen) firstSwap.set(session, ts);
    }
    const byTool = new Map<string, { calls: number; hit: number; miss: number; error: number }>();
    const callers = new Set<string>();
    const afterSwap = new Set<string>();
    for (const r of recall) {
      const tool = typeof r.tool === "string" ? r.tool : "(unrecorded)";
      const row = byTool.get(tool) ?? { calls: 0, hit: 0, miss: 0, error: 0 };
      row.calls++;
      row[r.outcome === "hit" || r.outcome === "miss" ? r.outcome : "error"]++;
      byTool.set(tool, row);
      const session = typeof r.session === "string" ? r.session : "(no session)";
      callers.add(session);
      const swapAt = firstSwap.get(session);
      if (swapAt !== undefined && (r.ts ?? 0) >= swapAt) afterSwap.add(session);
    }
    const sessions = (n: number) => (n === 1 ? "session" : "sessions");
    lines.push(
      `## Recall tool use (${recall.length} calls across ${callers.size} ${sessions(callers.size)})`,
      "",
      "| tool | calls | hit | miss | error |",
      "| ---- | ----- | --- | ---- | ----- |",
    );
    for (const [tool, row] of [...byTool.entries()].sort(
      (a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]),
    )) {
      lines.push(`| ${tool} | ${row.calls} | ${row.hit} | ${row.miss} | ${row.error} |`);
    }
    lines.push("");
    const silent = [...firstSwap.keys()].filter((s) => !callers.has(s)).length;
    lines.push(
      `${afterSwap.size} of ${callers.size} ${sessions(callers.size)} that used a recall tool had already applied a swap, so a projection pointer existed before the call. ` +
        (silent > 0
          ? `${silent} of ${firstSwap.size} ${sessions(firstSwap.size)} that applied a swap never called one.`
          : "Every session that applied a swap called one."),
      "",
    );
  }

  // The reader (lcm_expand_query) calls the model itself and hands the usage to
  // Pi on a tool result. `usage` rows only cover assistant messages, so the
  // reader's calls appear in this file here and nowhere else, and the turn
  // totals above do not include them.
  const reader = events.filter((e) => e.event === "lcm" && e.kind === "retrieval");
  if (reader.length > 0) {
    const s = sums(reader);
    lines.push(
      `## Retrieval reader spend (${reader.length} ${reader.length === 1 ? "call" : "calls"})`,
      "",
      "| calls | fresh input | cacheRead | cacheWrite | output | cost |",
      "| ----- | ----------- | --------- | ---------- | ------ | ---- |",
      `| ${s.turns} | ${fmtTokens(s.fresh)} | ${fmtTokens(s.cacheRead)} | ${fmtTokens(s.cacheWrite)} | ${fmtTokens(s.output)} | $${s.cost.toFixed(4)} |`,
      "",
      s.turns > 0 && s.fresh + s.cacheRead + s.output + s.cost === 0
        ? "No reader call in these rows reported provider counters."
        : "Reader calls are not part of the turn totals above: those count assistant-message `usage` rows, and the reader's calls arrive on tool results.",
      "",
    );
    let addressedSummary = 0;
    let addressedEntry = 0;
    for (const r of reader) {
      if (r.scope === "summary") addressedSummary++;
      else if (r.scope === "entry") addressedEntry++;
    }
    lines.push(
      "| addressed summary | addressed entry | searched |",
      "| ----------------- | --------------- | -------- |",
      `| ${addressedSummary} | ${addressedEntry} | ${reader.length - addressedSummary - addressedEntry} |`,
      "",
    );
  }

  // Pi compacting a session head is the one event that says the window was LCM's to hold and was not held.
  const piCompactions = events.filter((e) => e.event === "lcm" && e.kind === "pi-compaction");
  if (piCompactions.length > 0) {
    const bySession = new Map<string, { count: number; tokens: number; window: number }>();
    for (const c of piCompactions) {
      const session = typeof c.session === "string" ? c.session : "(no session)";
      const row = bySession.get(session) ?? { count: 0, tokens: 0, window: 0 };
      row.count++;
      if (typeof c.tokens === "number") row.tokens = Math.max(row.tokens, c.tokens);
      if (typeof c.window === "number") row.window = c.window;
      bySession.set(session, row);
    }
    const sessions = (n: number) => (n === 1 ? "session" : "sessions");
    lines.push(
      "## Window overflow (Pi's own compaction)",
      "",
      `Pi compacted a session head ${piCompactions.length} ${piCompactions.length === 1 ? "time" : "times"} across ${bySession.size} ${sessions(bySession.size)}: the window was LCM's to hold on those turns.`,
      "",
      "| session | compactions | highest occupancy seen | window |",
      "| ------- | ----------- | ---------------------- | ------ |",
    );
    for (const [session, row] of [...bySession.entries()].sort(
      (a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]),
    )) {
      lines.push(
        `| ${session} | ${row.count} | ${row.tokens > 0 ? fmtTokens(row.tokens) : "?"} | ${row.window > 0 ? fmtTokens(row.window) : "?"} |`,
      );
    }
    lines.push("");
  } else {
    lines.push(
      "## Window overflow (Pi's own compaction)",
      "",
      "Pi never compacted a session head in these rows, so the overflow rollback path has no evidence yet.",
      "",
    );
  }

  const sessions2 = (n: number) => (n === 1 ? "session" : "sessions");
  if (branchRemoved.length > 0) {
    const bySession = new Map<string, { removed: number; restored: number }>();
    for (const r of branchRemoved) {
      const session = r.session ?? "(none)";
      const row = bySession.get(session) ?? { removed: 0, restored: 0 };
      row.removed += typeof r.removed === "number" ? r.removed : 0;
      row.restored += typeof r.restored === "number" ? r.restored : 0;
      bySession.set(session, row);
    }
    lines.push(
      `## Branch navigation (${branchRemoved.length} ${branchRemoved.length === 1 ? "change" : "changes"} across ${bySession.size} ${sessions2(bySession.size)})`,
      "",
      "A tombstoned entry left the active path: its bytes are retained, `lcm_grep` skips it unless `include_removed` is set, and an explicit read returns it with a marker.",
      "",
      "| session | entries tombstoned | entries restored |",
      "| ------- | ------------------ | ---------------- |",
    );
    for (const [session, row] of [...bySession.entries()].sort(
      (a, b) => b[1].removed - a[1].removed || a[0].localeCompare(b[0]),
    )) {
      lines.push(`| ${session} | ${row.removed} | ${row.restored} |`);
    }
    lines.push("");
  }

  const byDay = new Map<string, Map<string, number>>();
  for (const e of health) {
    const day = dayOf(e.ts);
    const kind = e.kind ?? "unknown";
    const m = byDay.get(day) ?? new Map<string, number>();
    m.set(kind, (m.get(kind) ?? 0) + 1);
    byDay.set(day, m);
  }
  lines.push(`## Summarizer health (${health.length} error/capped/fallback/abandoned events)`, "");
  if (byDay.size === 0) {
    lines.push(
      "No summarizer errors, capped passes, model fallbacks, level-3 fallbacks, or abandoned passes recorded.",
    );
  } else {
    lines.push(
      "| day | summarizer-error | model-fallback | summary-fallback-stored | compaction-error | stale-pass | abandoned-pass | capped-pass |",
      "| --- | ---------------- | -------------- | ----------------------- | ---------------- | ---------- | -------------- | ----------- |",
    );
    for (const [day, m] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(
        `| ${day} | ${m.get("summarizer-error") ?? 0} | ${m.get("summarizer-fallback") ?? 0} | ${m.get("summary-fallback-stored") ?? 0} | ${m.get("compaction-error") ?? 0} | ${m.get("compaction-stale") ?? 0} | ${m.get("compaction-abandoned") ?? 0} | ${m.get("summarizer-capped") ?? 0} |`,
      );
    }
  }

  // A pass that covered nothing is not a fault, but it is a cost: the walk was
  // paid for and the span it was handed turned out to be no work.
  const noopRows = events.filter((e) => e.event === "lcm" && e.kind === "compaction-noop");
  if (noopRows.length > 0) {
    const byReason = new Map<string, number>();
    for (const e of noopRows) {
      const reason = typeof e.reason === "string" ? e.reason : "(unknown)";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    const causes = [...byReason.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, n]) => `${reason} ${n}`)
      .join(", ");
    lines.push(
      "## Passes that covered nothing",
      "",
      `${noopRows.length} ${noopRows.length === 1 ? "pass" : "passes"} produced no text: ${causes}. A covered span is memory already, and no stored rows means the span has no message row to summarize.`,
      "",
    );
  }

  // A capped pass is not a provider failure: the model answered nothing usable
  // often enough that the pass stopped paying. The category is what the
  // provider said the last time, so an expired key is told from a rate limit.
  const cappedRows = events.filter((e) => e.event === "lcm" && e.kind === "summarizer-capped");
  if (cappedRows.length > 0) {
    const byCategory = new Map<string, number>();
    for (const e of cappedRows) {
      const category = typeof e.category === "string" ? e.category : "(unknown)";
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    }
    const causes = [...byCategory.entries()]
      .sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b))
      .map(([category, n]) => `${category} ${n}`)
      .join(", ");
    lines.push(`Capped passes by cause: ${causes}.`, "");
  }

  const stalls = events.filter((e) => e.event === "lcm" && e.kind === "condensation-stalled");
  if (stalls.length > 0) {
    const byDayReason = new Map<
      string,
      { day: string; reason: string; n: number; worst: number }
    >();
    for (const s of stalls) {
      const day = dayOf(s.ts);
      const reason = typeof s.reason === "string" ? s.reason : "(unknown)";
      const key = `${day}|${reason}`;
      const row = byDayReason.get(key) ?? { day, reason, n: 0, worst: 0 };
      row.n++;
      const frontier = typeof s.frontierTokens === "number" ? s.frontierTokens : 0;
      const target = typeof s.targetTokens === "number" ? s.targetTokens : 0;
      row.worst = Math.max(row.worst, target > 0 ? frontier / target : 0);
      byDayReason.set(key, row);
    }
    lines.push(
      `## Condensation stalls (${stalls.length} passes over budget)`,
      "",
      "| day | reason | passes | worst frontier / target |",
      "| --- | ------ | ------ | ----------------------- |",
    );
    for (const row of [...byDayReason.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || a.reason.localeCompare(b.reason),
    )) {
      lines.push(
        `| ${row.day} | ${row.reason} | ${row.n} | ${row.worst > 0 ? `${row.worst.toFixed(2)}×` : "(unrecorded)"} |`,
      );
    }
    lines.push(
      "",
      "`depth-cap` means the balanced tree ran out of legal groups under `MAX_DAG_DEPTH`; `no-same-depth-run` means a lone node had no sibling to pair with, so the next pass merges it.",
      "",
    );
  }

  const reduced = events.filter((e) => e.event === "lcm" && e.kind === "condensation-reduced");
  if (reduced.length > 0) {
    const freed = reduced.reduce((n, r) => {
      const before = typeof r.beforeTokens === "number" ? r.beforeTokens : 0;
      const after = typeof r.afterTokens === "number" ? r.afterTokens : 0;
      return n + Math.max(0, before - after);
    }, 0);
    lines.push(
      `## Lone nodes brought back under budget (${reduced.length} re-summarized in place, ${fmtTokens(freed)} tokens freed)`,
      "",
    );
  }
  lines.push("");

  const loss = events.filter(
    (e) =>
      e.event === "lcm" && (e.kind === "summary-oversized" || e.kind === "summary-final-truncated"),
  );
  if (loss.length > 0) {
    const lossByDay = new Map<string, Map<string, number>>();
    for (const e of loss) {
      const day = dayOf(e.ts);
      const kind = e.kind ?? "unknown";
      const m = lossByDay.get(day) ?? new Map<string, number>();
      m.set(kind, (m.get(kind) ?? 0) + 1);
      lossByDay.set(day, m);
    }
    lines.push(
      `## Content lost or oversized (${loss.length} events)`,
      "",
      "| day | summary-oversized | summary-final-truncated |",
      "| --- | ----------------- | ----------------------- |",
    );
    for (const [day, m] of [...lossByDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(
        `| ${day} | ${m.get("summary-oversized") ?? 0} | ${m.get("summary-final-truncated") ?? 0} |`,
      );
    }
    lines.push(
      "",
      "`summary-oversized` is a stored node over its own budget, `summary-final-truncated` is the assembled text clipped to fit.",
      "",
    );
  }

  return lines.join("\n");
}
