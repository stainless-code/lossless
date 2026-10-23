import type { CompactionOutcome } from "lossless-core";

import type { CommandDefinition } from "./host.ts";
import { readMetricRows } from "./metrics.ts";

export interface StatusDeps {
  /** One status line per live sidecar, in session order. */
  readonly lines: () => string[];
  /** Submit the status text as a prompt in the calling session, the way
   * every OpenCode command shows its output. */
  readonly prompt: (sessionID: string, text: string) => Promise<unknown>;
}

/** The `lossless-status` command: report what the sidecar holds for this
 * session. A command cannot return text to the user directly, so the status
 * arrives as a prompt the loop answers from. */
export function statusCommand(deps: StatusDeps): CommandDefinition {
  return {
    name: "lossless-status",
    description: "Show what lossless memory holds for this session.",
    execute: async (input) => {
      const lines = deps.lines();
      const text =
        lines.length === 0
          ? "LCM: no stored history yet in this process."
          : `LCM sidecar status:\n${lines.join("\n")}`;
      await deps.prompt(input.sessionID, text);
    },
  };
}

export function statusLine(
  sessionId: string,
  dbPath: string,
  stats: { messages: number; summaries: number },
): string {
  return `${sessionId}: ${stats.messages} messages, ${stats.summaries} summaries (${dbPath})`;
}

export interface PassCommandDeps {
  /** Run one pass over the whole span this session's history maps to. */
  readonly run: (sessionID: string) => Promise<CompactionOutcome>;
  /** Submit the outcome as a prompt, the way `lossless-status` reports. */
  readonly prompt: (sessionID: string, text: string) => Promise<unknown>;
}

/** The `lossless-pass` command: compact the current span once, on demand, and
 * report what the sidecar stored. The context hook fills boundaries by itself;
 * this is the explicit way to run the same DAG pass before the swap point. */
export function passCommand(deps: PassCommandDeps): CommandDefinition {
  return {
    name: "lossless-pass",
    description: "Run one lossless compaction pass over this session's stored history.",
    execute: async (input) => {
      let text: string;
      try {
        text = passReport(await deps.run(input.sessionID));
      } catch (error) {
        text = `LCM pass failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      await deps.prompt(input.sessionID, text);
    },
  };
}

export function passReport(outcome: CompactionOutcome): string {
  if (outcome.kind === "stored") {
    return (
      `LCM pass: ${outcome.ingested} messages ingested; ` +
      `${outcome.leafSummaryIds.length} leaf + ${outcome.condensedSummaryIds.length} condensed ` +
      `summaries stored; summary ${outcome.summaryText.length} chars.`
    );
  }
  return `LCM pass: nothing stored (${outcome.reason}); ${outcome.ingested} messages ingested.`;
}

export interface ReportDeps {
  /** The sidecar directory whose `metrics.jsonl` this report reads. */
  readonly dir: string;
  /** Submit the report as a prompt in the calling session. */
  readonly prompt: (sessionID: string, text: string) => Promise<unknown>;
}

/** The `lossless-report` command: one bounded summary of this session's metric
 * rows. It is registered with or without `assembly`, because recall and reader
 * rows exist in both regimes. */
export function reportCommand(deps: ReportDeps): CommandDefinition {
  return {
    name: "lossless-report",
    description:
      "Summarize this session's lossless metrics: projection decisions, checkpoints, passes, recall, and reader runs.",
    execute: async (input) => {
      const rows = readMetricRows(deps.dir);
      await deps.prompt(input.sessionID, formatMetricsReport(rows, input.sessionID));
    },
  };
}

/** The report text. Bounded on purpose: every list is capped, because the loop
 * answers from this prompt and a metrics file can hold a long session. */
export function formatMetricsReport(rows: readonly unknown[], sessionID: string): string {
  const mine = rows.filter(
    (row): row is Record<string, unknown> => isRecord(row) && row.session === sessionID,
  );
  if (mine.length === 0) {
    return "LCM metrics: no rows recorded for this session yet.";
  }

  const lines = [
    `LCM metrics: ${mine.length} row(s) for this session (${rows.length} in the log).`,
  ];

  const projections = mine.filter((row) => row.kind === "projection");
  const actions = countsOf(projections.map((row) => stringOf(row.action)));
  const projectionParts = [...actions.entries()]
    .sort((a, b) => actionRank(a[0]) - actionRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([action, count]) => `${action} ${count}`);
  const reasonParts: string[] = [];
  for (const action of ["kick", "bail"]) {
    const reasons = countsOf(
      projections.filter((row) => row.action === action).map((row) => stringOf(row.reason)),
    );
    const top = topCounts(reasons, 3);
    if (top !== undefined) reasonParts.push(`${action}: ${top}`);
  }
  lines.push(
    `projections: ${projections.length}` +
      (projectionParts.length === 0 ? "" : ` (${projectionParts.join(", ")})`) +
      (reasonParts.length === 0 ? "" : `; ${reasonParts.join("; ")}`),
  );

  const checkpoints = mine.filter((row) => row.kind === "compaction-checkpoint");
  const written = checkpoints.filter((row) => row.action === "checkpoint");
  const skipped = checkpoints.filter((row) => row.action === "skip").length;
  const failed = checkpoints.filter((row) => row.action === "fail").length;
  const lastCheckpoint = written[written.length - 1];
  const lastIds = lastCheckpoint === undefined ? [] : numbersOf(lastCheckpoint.summaryIds);
  const lastChars = lastCheckpoint === undefined ? undefined : numberOf(lastCheckpoint.chars);
  lines.push(
    `checkpoints: ${written.length} written, ${skipped} skipped, ${failed} failed` +
      (lastCheckpoint === undefined
        ? ""
        : `; last ${lastIds.length === 0 ? "none" : lastIds.map((id) => `#${id}`).join(",")}` +
          (lastChars === undefined ? "" : ` (${lastChars} chars)`)),
  );

  const passes = mine.filter((row) => row.kind === "pass");
  const stored = passes.filter((row) => row.outcome === "stored").length;
  const nothing = passes.filter((row) => row.outcome === "nothing").length;
  const failures = passes.filter((row) => row.outcome === "failed").length;
  const leaf = sumField(passes, "leaf");
  const condensed = sumField(passes, "condensed");
  lines.push(
    `passes: ${passes.length} (stored ${stored}, nothing ${nothing}, failed ${failures}); ` +
      `${leaf} leaf, ${condensed} condensed`,
  );

  const recall = mine.filter((row) => row.kind === "recall");
  const byTool = new Map<string, Map<string, number>>();
  for (const row of recall) {
    const tool = stringOf(row.tool) ?? "(unrecorded)";
    const outcome = stringOf(row.outcome) ?? "(unrecorded)";
    const outcomes = byTool.get(tool) ?? new Map<string, number>();
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    byTool.set(tool, outcomes);
  }
  const tools = [...byTool.entries()].sort(
    (a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]),
  );
  const toolParts = tools.slice(0, 5).map(([tool, outcomes]) => {
    const parts = ["hit", "miss", "refused", "error"].flatMap((outcome) => {
      const count = outcomes.get(outcome) ?? 0;
      return count === 0 ? [] : [`${outcome} ${count}`];
    });
    return `${tool} ${total(outcomes)}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
  });
  if (tools.length > 5) toolParts.push(`+${tools.length - 5} more tool(s)`);
  lines.push(`recall: ${toolParts.length === 0 ? "none" : toolParts.join("; ")}`);

  const reader = mine.filter((row) => row.kind === "reader");
  const answered = reader.filter((row) => row.outcome === "answered").length;
  const readerFailed = reader.filter((row) => row.outcome === "failed").length;
  const timeouts = reader.filter((row) => row.outcome === "timeout").length;
  const durations = reader
    .map((row) => numberOf(row.durationMs))
    .filter((value): value is number => value !== undefined);
  const average =
    durations.length === 0
      ? 0
      : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  lines.push(
    `reader: ${reader.length} (${answered} answered, ${readerFailed} failed, ${timeouts} timeout); avg ${average} ms`,
  );

  const lastDecision = projections[projections.length - 1];
  if (lastDecision === undefined) {
    lines.push("last decision: none recorded.");
  } else {
    const occupancy = numberOf(lastDecision.occupancy);
    const tokens = numberOf(lastDecision.tokens);
    lines.push(
      `last decision: ${stringOf(lastDecision.action) ?? "(unrecorded)"}` +
        (occupancy === undefined ? "" : ` at ${occupancy.toFixed(3)} occupancy`) +
        (tokens === undefined ? "" : ` (${tokens} tokens)`),
    );
  }

  const text = lines.join("\n");
  return text.length <= 2048 ? text : `${text.slice(0, 2040)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numbersOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
  );
}

function sumField(rows: readonly Record<string, unknown>[], key: string): number {
  return rows.reduce((sum, row) => sum + (numberOf(row[key]) ?? 0), 0);
}

function countsOf(values: readonly (string | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function topCounts(counts: Map<string, number>, max: number): string | undefined {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const parts = sorted.slice(0, max).map(([key, count]) => `${key} ${count}`);
  if (sorted.length > max) parts.push(`+${sorted.length - max} more`);
  return parts.length === 0 ? undefined : parts.join(", ");
}

function total(outcomes: Map<string, number>): number {
  return [...outcomes.values()].reduce((sum, value) => sum + value, 0);
}

/** The report reads in the order a turn moves through the policy, so a fixed
 * rank beats a frequency sort that reshuffles between runs. */
function actionRank(action: string): number {
  const order = ["quiet", "swap", "reapply", "kick", "bail"];
  const index = order.indexOf(action);
  return index === -1 ? order.length : index;
}
