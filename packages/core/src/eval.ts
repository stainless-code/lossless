import { renderFrontier } from "./assembly.ts";
import { runCompaction } from "./compaction-engine.ts";
import { estimateTokens } from "./estimate-tokens.ts";
import { ingestEntries } from "./ingest.ts";
import { appendMetric } from "./metrics.ts";
import { expandView, grepView } from "./recall-view.ts";
import { redactSecrets } from "./redact.ts";
import { LcmStore, type LcmRole, type StoredMessage } from "./store.ts";

/** The seed CI runs. Fixed, so a change in the answer is a change in the engine
 * rather than a change in the fixture. */
export const SMALL_SEED = 20_260_915;

export interface EvalOptions {
  seed: number;
  turns: number;
  needles: number;
  fillerChars: number;
}

export interface EvalNeedle {
  id: string;
  entryId: string;
  value: number;
  /** The exact text stored in the entry, `N07=4821`. */
  line: string;
}

export interface EvalFixture {
  seed: number;
  entries: Array<{ entryId: string; role: LcmRole; text: string; timestamp: number }>;
  needles: EvalNeedle[];
  key: { needles: number; sum: number };
}

/** mulberry32: 32 bits of state, integer output, no dependency. The generator is
 * the fixture, so it has to be as frozen as the seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER_WORDS = [
  "the",
  "pass",
  "walked",
  "the",
  "span",
  "and",
  "stored",
  "a",
  "summary",
  "whose",
  "provenance",
  "names",
  "every",
  "message",
  "it",
  "covers",
];

/** Context of any length, with the answer key beside it. Needles are spread
 * across the turns rather than clustered at one end, so a pass that walks the
 * oldest span first meets needles at every depth. */
export function generateContext(opts: EvalOptions): EvalFixture {
  const { seed, turns, needles, fillerChars } = opts;
  const rand = seededRandom(seed);
  const entries: EvalFixture["entries"] = [];
  const needleAt = new Map<number, number>();
  for (let i = 0; i < needles; i++) {
    needleAt.set(Math.floor((i * turns) / Math.max(1, needles)), i);
  }
  const found: EvalNeedle[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const entryId = `e${String(turn).padStart(4, "0")}`;
    const role: LcmRole = turn % 3 === 0 ? "user" : turn % 3 === 1 ? "assistant" : "toolResult";
    const lines: string[] = [];
    let budget = Math.max(1, fillerChars + Math.floor(rand() * 40));
    while (budget > 0) {
      const word = FILLER_WORDS[Math.floor(rand() * FILLER_WORDS.length)]!;
      lines.push(word);
      budget -= word.length + 1;
    }
    const index = needleAt.get(turn);
    if (index !== undefined) {
      const value = 1000 + Math.floor(rand() * 9000);
      const id = `N${String(index).padStart(2, "0")}`;
      const line = `${id}=${value}`;
      found.push({ id, entryId, value, line });
      lines.splice(Math.floor(lines.length / 2), 0, line);
    }
    entries.push({
      entryId,
      role,
      text: lines.join(" "),
      timestamp: turn,
    });
  }
  found.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    seed,
    entries,
    needles: found,
    key: { needles: found.length, sum: found.reduce((n, x) => n + x.value, 0) },
  };
}

/** How many uncovered messages one pass takes. Wide enough that a pass writes
 * several leaf chunks and then condenses them, so "N compactions" exercises the
 * DAG's second level and not only its first. */
export const EVAL_SPAN_MESSAGES = 24;

export const EVAL_LEAF_CHUNK_TOKENS = 2_000;

/** The token budget the pass must fit its frontier into, small on purpose: it is
 * what makes a pass condense the leaves it just wrote. */
export const EVAL_TARGET_TOKENS = 400;

/** A deterministic summarizer: the head of its input, no provider call. What
 * this harness measures is retrieval under this build's own passes, so the
 * summary quality on top of them is deliberately fixed and deliberately poor. */
function mechanicalSummarizer(maxChars = 1_200): (system: string, user: string) => Promise<string> {
  return async (_system: string, user: string) => {
    const flat = user.replace(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : flat.slice(0, maxChars);
  };
}

export interface EvalResult {
  seed: number;
  turns: number;
  needles: number;
  passes: number;
  depth: number;
  summaries: number;
  condensed: number;
  fidelity: number;
  covered: number;
  readable: number;
  fromProjection: number;
  fromRecall: number;
  failed: number;
  surfaceTokens: number;
  answered: boolean;
}

export interface EvalRunOptions {
  passes: number;
  dbPath?: string;
  record?: boolean;
}

export async function runEval(opts: EvalOptions, run: EvalRunOptions): Promise<EvalResult> {
  const fixture = generateContext(opts);
  const store = new LcmStore(run.dbPath ?? ":memory:");
  try {
    ingestEntries(store, fixture.entries);
    const passes = await runPasses(store, run.passes);
    const fidelity = countFidelity(store, fixture);
    const surface = surfaceOf(store);
    const read = readAggregate(store, fixture, surface.text);
    const result: EvalResult = {
      seed: fixture.seed,
      turns: fixture.entries.length,
      needles: fixture.needles.length,
      passes,
      depth: deepestDepth(store),
      summaries: store.allSummaries().length,
      condensed: store.allSummaries().filter((s) => s.kind === "condensed").length,
      fidelity: fidelity.verbatim,
      covered: fidelity.covered,
      readable: fidelity.readable,
      fromProjection: read.fromProjection,
      fromRecall: read.fromRecall,
      failed: read.failed,
      surfaceTokens: surface.tokens,
      answered: read.answered,
    };
    if (run.record !== false) {
      appendMetric({
        event: "lcm",
        kind: "eval",
        seed: result.seed,
        turns: result.turns,
        needles: result.needles,
        passes: result.passes,
        depth: result.depth,
        fidelity: result.fidelity,
        fromProjection: result.fromProjection,
        fromRecall: result.fromRecall,
        failed: result.failed,
        surfaceTokens: result.surfaceTokens,
      });
    }
    return result;
  } finally {
    store.close();
  }
}

async function runPasses(store: LcmStore, requested: number): Promise<number> {
  const summarize = mechanicalSummarizer();
  let done = 0;
  for (let pass = 0; pass < requested; pass++) {
    const span = store.entrySpan();
    if (!span) break;
    const uncovered = store.uncoveredMessagesInSpan(span.first, span.last);
    if (uncovered.length === 0) break;
    const chunk = uncovered.slice(0, EVAL_SPAN_MESSAGES);
    const outcome = await runCompaction(
      store,
      {
        span: chunk.map((m) => ({ entryId: m.entryId, role: m.role, text: m.text })),
        targetTokens: EVAL_TARGET_TOKENS,
      },
      summarize,
      { leafChunkTokens: EVAL_LEAF_CHUNK_TOKENS, maxChunks: 16, redact: redactSecrets },
    );
    if (outcome.kind !== "stored") break;
    done++;
  }
  return done;
}

interface Fidelity {
  verbatim: number;
  covered: number;
  readable: number;
}

/** Fidelity is an address check, not a similarity check: the bytes are returned,
 * the DAG covers them, and a bounded reader reaches them. A summary is allowed to
 * drop a fact; this build's contract is that the fact stays addressable. */
function countFidelity(store: LcmStore, fixture: EvalFixture): Fidelity {
  let verbatim = 0;
  let covered = 0;
  let readable = 0;
  for (const needle of fixture.needles) {
    const row = store.messageByEntryId(needle.entryId);
    if (!row || !row.text.includes(needle.line)) continue;
    verbatim++;
    if (store.coveringSummaryId(needle.entryId) !== undefined) covered++;
    const window = expandView(store, redactSecrets, {
      mode: "message",
      entryId: needle.entryId,
      charOffset: 0,
      maxChars: 20_000,
    });
    if (window.ok && window.text.includes(needle.line)) readable++;
  }
  return { verbatim, covered, readable };
}

/** What a model sees without recall: the rendered frontier plus the messages no
 * committed summary covers. `renderFrontier` is the engine's own renderer, so
 * this is the digest it would put in context, not a copy of it. */
function surfaceOf(store: LcmStore): { text: string; tokens: number } {
  const span = store.entrySpan();
  if (!span) return { text: "", tokens: 0 };
  const frontier = store.frontier(span.first, span.last);
  const digest = renderFrontier(
    frontier.map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      tokens: n.tokens,
      firstEntryId: n.firstEntryId,
      lastEntryId: n.lastEntryId,
      depth: n.depth,
    })),
  );
  const tail = store
    .uncoveredMessagesInSpan(span.first, span.last)
    .map((m: StoredMessage) => m.text)
    .join("\n");
  const text = `${digest}\n${tail}`;
  return { text, tokens: estimateTokens(text) };
}

interface AggregateRead {
  fromProjection: number;
  fromRecall: number;
  failed: number;
  answered: boolean;
}

function readAggregate(store: LcmStore, fixture: EvalFixture, surface: string): AggregateRead {
  const values = new Map<string, number>();
  for (const needle of fixture.needles) {
    if (surface.includes(needle.line)) values.set(needle.id, needle.value);
  }
  const fromProjection = values.size;
  let fromRecall = 0;
  for (const needle of fixture.needles) {
    if (values.has(needle.id)) continue;
    const view = grepView(store, redactSecrets, { query: needle.id, limit: 10 });
    if (!view.ok || !view.text.includes(needle.line)) continue;
    values.set(needle.id, needle.value);
    fromRecall++;
  }
  const failed = fixture.needles.length - fromProjection - fromRecall;
  const sum = [...values.values()].reduce((a, b) => a + b, 0);
  return {
    fromProjection,
    fromRecall,
    failed,
    answered: failed === 0 && values.size === fixture.key.needles && sum === fixture.key.sum,
  };
}

function deepestDepth(store: LcmStore): number {
  return store.allSummaries().reduce((max, s) => Math.max(max, s.depth), 0);
}

export function formatEvalTable(results: readonly EvalResult[]): string {
  const header = [
    "turns",
    "needles",
    "passes",
    "depth",
    "summaries",
    "verbatim",
    "covered",
    "readable",
    "projection",
    "recall",
    "failed",
    "surface tok",
    "answered",
  ];
  const rows = results.map((r) =>
    [
      r.turns,
      r.needles,
      r.passes,
      r.depth,
      r.summaries,
      r.fidelity,
      r.covered,
      r.readable,
      r.fromProjection,
      r.fromRecall,
      r.failed,
      r.surfaceTokens,
      r.answered ? "yes" : "no",
    ].join(" | "),
  );
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r} |`),
  ].join("\n");
}
