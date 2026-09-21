import { estimateTokens } from "./estimate-tokens.ts";
import { entryToText } from "./ingest.ts";

export interface AssemblyMsg {
  role: string;
  content?: unknown;
  /** AgentMessage UserMessage compatibility (Pi requires it on outgoing messages). */
  timestamp?: number;
}

export interface AlignedEntry {
  entryId: string;
  role: string;
  text: string;
  /** Raw content blocks when `text` is not a faithful rendering of them
   * (`payloadOf`). Carried so ingest stores the same bytes at every call site. */
  payload?: string;
  fileHint?: { path: string };
}

export const SYNTHETIC_MARKER = "[LCM session memory";

const TAIL_KEY_PREFIX_CHARS = 200;

export function tailKeyOf(m: AssemblyMsg | undefined): string {
  if (!m) return "";
  return JSON.stringify([m.role, entryToText(m.content).slice(0, TAIL_KEY_PREFIX_CHARS)]);
}

/** Characters the estimator counts for a context: the same rendering `cutIndexFor`
 * measures, so a calibration describes the quantity every threshold here is
 * compared against. */
export function contextChars(messages: readonly AssemblyMsg[]): number {
  let chars = 0;
  for (const m of messages) chars += JSON.stringify(m)?.length ?? 0;
  return chars;
}

export function cutIndexFor(
  messages: readonly AssemblyMsg[],
  keepRecentTokens: number,
): number | null {
  let acc = 0;
  let i = messages.length - 1;
  while (i > 0) {
    acc += estimateTokens(JSON.stringify(messages[i]) ?? "");
    if (acc >= keepRecentTokens) break;
    i--;
  }
  let cut = i;
  while (cut > 0 && messages[cut]!.role !== "user") cut--;
  if (messages[cut]?.role === "user") {
    if (cut > 0 || i === 0) return cut;
    for (let j = i; j > 0; j--) if (messages[j]!.role !== "toolResult") return j;
    return null;
  }
  for (let ahead = i + 1; ahead < messages.length; ahead++) {
    if (messages[ahead]!.role === "user") return ahead;
  }
  return null;
}

export interface SyntheticMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export type SummaryTier = "rich" | "terse" | "stub";

export interface RenderableSummary {
  id: number;
  depth: number;
  firstEntryId: string;
  lastEntryId: string;
  text: string;
  thoroughText?: string;
  tier: SummaryTier;
}

export const STUB_CHARS = 200;

export type PlainSummary = Omit<RenderableSummary, "tier" | "thoroughText">;

export function renderSummaries(summaries: readonly RenderableSummary[]): string {
  return summaries.map(renderSummary).join("\n\n");
}

export function renderFrontier(nodes: readonly PlainSummary[]): string {
  return nodes.map(renderPlain).join("\n\n");
}

function summaryHeader(s: PlainSummary): string {
  return `[lcm:summary #${s.id} depth ${s.depth} span ${s.firstEntryId}..${s.lastEntryId}]`;
}

function renderSummary(s: RenderableSummary): string {
  const header = summaryHeader(s);
  if (s.tier === "stub") {
    const kept = s.text.replace(/\s+/g, " ").trim().slice(0, STUB_CHARS);
    return `${header}\n${kept} [lcm:stub, ${s.text.length} chars elided; lcm_describe(${s.id}) has the full summary]`;
  }
  return `${header}\n${s.tier === "rich" ? (s.thoroughText ?? s.text) : s.text}`;
}

function renderPlain(n: PlainSummary): string {
  return `${summaryHeader(n)}\n${n.text}`;
}

export function buildSynthetic(summaries: readonly RenderableSummary[]): SyntheticMessage {
  const stubbed = summaries.filter((s) => s.tier === "stub").length;
  const stubNote =
    stubbed > 0
      ? ` ${stubbed} of ${summaries.length} summaries are stubbed to fit the projection budget; lcm_describe(id) returns any node's full text.`
      : "";
  return {
    role: "user",
    timestamp: Date.now(),
    content:
      `${SYNTHETIC_MARKER}: earlier conversation is compacted into the summaries below. ` +
      `Originals are recoverable verbatim: lcm_expand_query(query, prompt) reads them from the store, lcm_grep(query) finds them.${stubNote}\n\n${renderSummaries(summaries)}`,
  };
}
