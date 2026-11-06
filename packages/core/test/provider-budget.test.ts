import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import type { CompactionSpanEntry } from "../src/compaction-engine.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { runHeal } from "../src/heal.ts";
import { ingestEntries } from "../src/ingest.ts";
import { makeLlm, REASONING_HEADROOM } from "../src/llm.ts";
import { LcmStore, TRUNCATED_SUMMARY_PREFIX } from "../src/store.ts";
import { storedPass } from "./support/pass-outcome.ts";
import { strictHost, type StrictHost } from "./support/strict-host.ts";

const SESSION = "sess-budget";
const MODEL = "p/reasoner";

function seeded(count: number, chars: number): CompactionSpanEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${i}: `.padEnd(chars, "z"),
  }));
}

function hostDouble(answer = "ok"): StrictHost {
  return strictHost([{ key: MODEL, reasoning: true, answer }], MODEL);
}

/** Infinite call and pass budgets are how a boundary case reaches the request
 * builder: the pass cap would otherwise refuse an infinite target before it
 * becomes a request, and the port, not the cap, is what this file checks. */
function compacting(host: StrictHost, span: CompactionSpanEntry[], openBudget = false) {
  return makeLlm(
    host.host,
    openBudget
      ? {
          summarizer: MODEL,
          summarizerTokensPerCall: Number.POSITIVE_INFINITY,
          summarizerTokensPerPass: Number.POSITIVE_INFINITY,
        }
      : { summarizer: MODEL },
    {
      session: SESSION,
      stage: "async",
      span: { firstEntryId: span[0]!.entryId, lastEntryId: span[span.length - 1]!.entryId },
    },
  );
}

function assertWholeBudgets(host: StrictHost, stage: string, least: number): void {
  assert.deepEqual(host.refused, [], `${stage}: a strict provider rejected a budget`);
  assert.ok(
    host.calls.length >= least,
    `${stage}: expected at least ${least} accepted request(s), saw ${host.calls.length}`,
  );
  for (const call of host.calls) {
    assert.ok(
      Number.isInteger(call.maxTokens) && call.maxTokens >= 0,
      `${stage}: maxTokens ${call.maxTokens} is not a non-negative integer`,
    );
  }
}

async function runPass(
  span: CompactionSpanEntry[],
  leafChunkTokens: number,
  targetTokens: number,
  answer = "ok",
  openBudget = false,
): Promise<StrictHost> {
  const host = hostDouble(answer);
  const llm = compacting(host, span, openBudget);
  assert.ok(llm);
  const store = new LcmStore(":memory:");
  try {
    await storedPass(store, { span, targetTokens }, llm, {
      leafChunkTokens,
      session: SESSION,
      stage: "async",
    });
  } finally {
    store.close();
  }
  return host;
}

async function healRepair(): Promise<StrictHost> {
  const host = hostDouble("healed leaf");
  const store = new LcmStore(":memory:");
  try {
    ingestEntries(store, [
      { entryId: "e0", role: "user", text: `SOURCE-0 ${"z".repeat(700)}`, timestamp: 0 },
      { entryId: "e1", role: "assistant", text: `SOURCE-1 ${"z".repeat(700)}`, timestamp: 1 },
    ]);
    const messages = store.messagesInSpan("e0", "e1");
    const mechanical = `${TRUNCATED_SUMMARY_PREFIX}\nmechanical`;
    store.insertSummary({
      kind: "leaf",
      text: mechanical,
      tokens: estimateTokens(mechanical),
      depth: 0,
      firstEntryId: "e0",
      lastEntryId: "e1",
      quality: "mechanical",
      messageIds: messages.map((message) => message.id),
    });
    const llm = makeLlm(
      host.host,
      { summarizer: MODEL },
      {
        session: SESSION,
        stage: "heal",
        span: { firstEntryId: "e0", lastEntryId: "e1" },
      },
    );
    assert.ok(llm);
    await runHeal(store, { session: SESSION, targetTokens: 1447, sourceTokens: 2895 }, llm);
  } finally {
    store.close();
  }
  return host;
}

interface Stage {
  name: string;
  least: number;
  run: () => Promise<StrictHost>;
}

const STAGES: Stage[] = [
  { name: "a leaf", least: 1, run: () => runPass(seeded(2, 800), 2895, 1500) },
  { name: "tiled chunks", least: 2, run: () => runPass(seeded(15, 800), 2895, 1500) },
  {
    name: "the condensed tier",
    least: 4,
    run: () => runPass(seeded(6, 400), 201, 40, "leaf summary detail ".repeat(20)),
  },
  { name: "a heal repair", least: 1, run: healRepair },
];

for (const stage of STAGES) {
  test(`pass: ${stage.name} over an odd chunk budget asks the host for whole budgets only`, async () => {
    assertWholeBudgets(await stage.run(), stage.name, stage.least);
  });
}

const LEAF_TARGETS: Array<{
  label: string;
  leafChunkTokens: number;
  expected: number;
  open?: boolean;
}> = [
  { label: "0", leafChunkTokens: 0, expected: 1 },
  { label: "1", leafChunkTokens: 2, expected: 1 },
  { label: "0.5", leafChunkTokens: 1, expected: 1 },
  { label: "1.5", leafChunkTokens: 3, expected: 2 },
  { label: "1447.5", leafChunkTokens: 2895, expected: 1448 },
  { label: "1447.25", leafChunkTokens: 2894.5, expected: 1447 },
  { label: "NaN", leafChunkTokens: Number.NaN, expected: 1 },
  { label: "Infinity", leafChunkTokens: Number.POSITIVE_INFINITY, expected: 1, open: true },
];

for (const target of LEAF_TARGETS) {
  test(`pass: a leaf target of ${target.label} reaches the host as ${target.expected} plus headroom`, async () => {
    const host = await runPass(
      seeded(2, 800),
      target.leafChunkTokens,
      150,
      "ok",
      target.open === true,
    );
    assertWholeBudgets(host, `leaf target ${target.label}`, 1);
    assert.deepEqual(
      [...new Set(host.calls.map((call) => call.maxTokens))],
      [target.expected + REASONING_HEADROOM],
    );
  });
}
