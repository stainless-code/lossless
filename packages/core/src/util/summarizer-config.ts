/** The summarizer knobs every host shares. One helper turns resolved plugin
 * options into the engine's config, so the direct, async, and blocking paths
 * cannot drift on a budget or a chain. Heal carries its own token budget
 * because it re-derives nodes a pass already paid for. */

import { scaledBudget } from "../estimate-tokens.ts";
import { SUMMARIZER_CALL_TOKENS, SUMMARIZER_PASS_TOKENS, type SummarizerConfig } from "../llm.ts";

/** Tokens one bounded repair run may spend across all of its calls. A heal
 * re-derives nodes a pass already paid for, so it carries its own budget. */
export const SUMMARIZER_HEAL_TOKENS = 120_000;

/** Tokens one repaired node targets when the caller names none. It matches
 * the heal engine's own fallback, so an unresolved option still repairs. */
export const DEFAULT_SUMMARY_TOKENS = 1500;

export interface SummarizerOptions {
  /** One model id, or an ordered fallback chain. `auto` is the session model. */
  readonly summarizer?: string | string[];
  /** Tokens one request may cost, estimate plus output cap, before it is
   * refused rather than paid for. */
  readonly summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all of its calls. */
  readonly summarizerTokensPerPass?: number;
  /** Tokens one on-demand heal run may spend across all of its calls. */
  readonly summarizerTokensPerHeal?: number;
  /** Fires at compaction time only; ingest still stores every message verbatim. */
  readonly mechanicalTools?: readonly string[];
}

/** Empty default: callers opt in and existing passes keep their spend. */
export const DEFAULT_MECHANICAL_TOOLS: readonly string[] = [];

export function normalizeMechanicalTools(tools: readonly string[] | undefined): string[] {
  if (!tools) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of tools) {
    const name = entry.trim().toLowerCase();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The tool name a message carries, if any. Reads both hosts: `tool <name>`
 * (OpenCode), `[tool:<name>]` (core), `tool-call: <name>`, plus a JSON
 * payload that names the call. Lowercased, else undefined.
 *
 * A marker only counts at a block start: `entryToText` joins content blocks
 * with newlines, so a genuine call marker opens a line while prose quoting one
 * sits mid-line. The caller may pass the stored role: `user` and `custom` rows
 * never carry calls, and an `assistant` row mixing prose with a call keeps the
 * prose on the summarizer path (tool-only rows still skip). */
export function mechanicalToolNameOf(message: {
  text: string;
  payload?: string;
  role?: string;
}): string | undefined {
  if (message.role === "user" || message.role === "custom") return undefined;
  if (
    message.role === "assistant" &&
    message.text.trim().length > 0 &&
    !isToolOnlyText(message.text)
  ) {
    return undefined;
  }
  const fromText = toolNameOfText(message.text, message.role);
  if (fromText !== undefined) return fromText;
  return toolNameOfPayload(message.payload);
}

/** The literal marker line a row carries, if any. Same line scan the
 * mechanical decision reads, without the tool-only gate: a scope matcher
 * calls this directly so a call embedded in prose still anchors. */
export function toolNameOfText(text: string, role?: string): string | undefined {
  const head = text.match(/^\s*tool\s+([A-Za-z0-9_:\-/.]+)/i);
  if (head?.[1]) return head[1].toLowerCase();
  const lineMarker = /^\s*(?:\[tool:([^\]]+)\]|tool[_-]?call:\s*([A-Za-z0-9_:\-/.]+))/i;
  if (role === "toolResult") {
    // A result body may quote another tool's marker further down, so only the
    // opening line can name the tool that produced it.
    const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    const hit = first.match(lineMarker);
    const name = (hit?.[1] ?? hit?.[2])?.trim().toLowerCase();
    return name && name.length > 0 ? name : undefined;
  }
  for (const line of text.split("\n")) {
    const hit = line.match(lineMarker);
    const name = (hit?.[1] ?? hit?.[2])?.trim().toLowerCase();
    if (name && name.length > 0) return name;
  }
  return undefined;
}

/** Every non-blank line opens a tool-call block, the shape `entryToText`
 * renders for a message holding calls and nothing else. */
function isToolOnlyText(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) =>
    /^\s*(?:tool\s+[A-Za-z0-9_:\-/.]+|\[tool:[^\]]+\]|tool[_-]?call:\s*[A-Za-z0-9_:\-/.]+)/i.test(
      line,
    ),
  );
}

function toolNameOfPayload(payload: string | undefined): string | undefined {
  if (!payload) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    for (const key of ["name", "tool", "toolName"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim().toLowerCase();
    }
  }
  return undefined;
}

/** Normalized here, so callers may pass raw config values. */
export function isMechanicalToolMessage(
  message: { text: string; payload?: string; role?: string },
  tools: readonly string[],
): boolean {
  if (tools.length === 0) return false;
  const name = mechanicalToolNameOf(message);
  if (name === undefined) return false;
  const allowed = tools.some((entry) => entry.trim().toLowerCase() === name);
  return allowed;
}

/** The engine config for these options. An unresolved budget keeps the core
 * default, which is also what a direct caller that passes no options gets. */
export function summarizerConfig(options: SummarizerOptions): SummarizerConfig {
  return {
    ...(options.summarizer === undefined ? {} : { summarizer: options.summarizer }),
    summarizerTokensPerCall: options.summarizerTokensPerCall ?? SUMMARIZER_CALL_TOKENS,
    summarizerTokensPerPass: options.summarizerTokensPerPass ?? SUMMARIZER_PASS_TOKENS,
  };
}

export interface HealBudgetOptions {
  /** Tokens one repaired node targets. */
  readonly summaryTokens?: number;
  /** Estimated tokens one heal node may read as source. Unset derives the
   * engine default; this is the explicit override for large sources. */
  readonly healSourceTokens?: number;
  /** Tokens one summarizer request may cost. */
  readonly summarizerTokensPerCall?: number;
}

/** Calibrated heal budgets in tokens: node target, per-call cap, and optional source window. */
export interface HealBudgets {
  readonly targetTokens: number;
  readonly callBudgetTokens: number;
  readonly sourceTokens?: number;
}

/** The calibrated heal target and source window. A null ratio keeps the
 * configured reading, which is what an uncalibrated host passes. */
export function healBudgets(
  options: HealBudgetOptions = {},
  charsPerToken: number | null = null,
): HealBudgets {
  const targetTokens = scaledBudget(options.summaryTokens ?? DEFAULT_SUMMARY_TOKENS, charsPerToken);
  const sourceTokens =
    options.healSourceTokens === undefined
      ? undefined
      : scaledBudget(options.healSourceTokens, charsPerToken);
  return {
    targetTokens,
    callBudgetTokens: options.summarizerTokensPerCall ?? SUMMARIZER_CALL_TOKENS,
    ...(sourceTokens === undefined ? {} : { sourceTokens }),
  };
}
