import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { cutIndexFor, buildSynthetic, SYNTHETIC_MARKER } from "../src/assembly.ts";
import { renderSummaries } from "../src/assembly.ts";
import type { AlignedEntry } from "../src/assembly.ts";
import type { AssemblyMsg } from "../src/assembly.ts";
import { tailKeyOf } from "../src/assembly.ts";
import {
  effectiveThresholds,
  nextAction,
  cutMayReplace,
  type CommitState,
} from "../src/commit-policy.ts";
import {
  applyContextPolicy,
  resolveCompactionSpan,
  type ContextPolicyInput,
  type ContextPolicyDeps,
  type ContextPolicyResult,
} from "../src/context-policy.ts";
import { shouldKickBoundary, KICK_BACKOFF_MS } from "../src/context-policy.ts";
import { ingestEntries } from "../src/ingest.ts";
import type { LcmMetricRecord } from "../src/metrics.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";
import type { SummaryNode } from "../src/store.ts";

function asOutcome<T extends ContextPolicyResult["outcome"]>(
  result: ContextPolicyResult,
  expected: T,
): Extract<ContextPolicyResult, { outcome: T }> {
  assert.equal(result.outcome, expected, `outcome ${result.outcome}`);
  return result as Extract<ContextPolicyResult, { outcome: T }>;
}

function rowsOfKind<K extends LcmMetricRecord["kind"]>(
  rows: readonly LcmMetricRecord[],
  kind: K,
): Array<Extract<LcmMetricRecord, { kind: K }>> {
  return rows.filter((r): r is Extract<LcmMetricRecord, { kind: K }> => r.kind === kind);
}

const WINDOW = 1_000_000;
const SWAP = 0.7;
const RECUT = 0.85;

const arraySpanBounds: ContextPolicyDeps["spanBounds"] = (aged) => ({
  firstEntryId: aged[0].entryId,
  lastEntryId: (aged[aged.length - 1] ?? aged[0]).entryId,
});

function rawMsgs(n: number): { role: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
  }));
}

function entries(n: number): AlignedEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    entryId: `e${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `message ${i}`,
  }));
}

function summary(lastEntryId: string): SummaryNode {
  return {
    id: 1,
    kind: "leaf",
    text: "summary text",
    tokens: 10,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId,
    createdAt: 0,
  };
}

function pin(cutCount: number): CommitState {
  const firstKept = {
    role: cutCount % 2 === 0 ? "user" : "assistant",
    content: `message ${cutCount}`,
  };
  return {
    cutCount,
    synthetic: { role: "user", content: `${SYNTHETIC_MARKER} frozen`, timestamp: 0 },
    summaryId: 1,
    appliedAtOccupancy: 0.72,
    tailKey: tailKeyOf(firstKept),
    applied: [
      { id: 1, depth: 0, text: "frozen", firstEntryId: "e0", lastEntryId: "e2", tier: "terse" },
    ],
  };
}

interface Opts {
  occupancy?: number;
  commitState?: CommitState | null;
  pinnedModelKey?: string;
  pinnedWindow?: number;
  clampNotified?: boolean;
  modelKey?: string;
  summary?: SummaryNode | undefined;
  frontierNodes?: SummaryNode[];
  cutIndex?: number | "real" | "none";
  messages?: AssemblyMsg[];
  clamped?: boolean;
  entryCount?: number;
  summaryTokens?: number;
  redact?: (text: string) => string;
}

function run(opts: Opts = {}) {
  const rawMessages = opts.messages ?? rawMsgs(opts.entryCount ?? 6);
  const rawEntries =
    opts.messages === undefined
      ? entries(opts.entryCount ?? 6)
      : opts.messages.map((m, i) => ({ entryId: `e${i}`, role: m.role, text: "" }));
  const input: ContextPolicyInput = {
    rawMessages,
    getCtxEntries: () => rawEntries,
    occupancy: opts.occupancy ?? 0.8,
    tokens: Math.round((opts.occupancy ?? 0.8) * WINDOW),
    contextWindow: WINDOW,
    modelKey: opts.modelKey ?? "test/model",
    thresholds: {},
    keepRecentTokens: 20_000,
    summaryTokens: opts.summaryTokens ?? 1500,
    clampNotified: opts.clampNotified ?? false,
    commitState: opts.commitState === undefined ? null : opts.commitState,
    pinnedModelKey: opts.pinnedModelKey ?? "test/model",
    pinnedWindow: opts.pinnedWindow ?? WINDOW,
  };
  const fakeCut =
    opts.cutIndex === "real" ? undefined : opts.cutIndex === "none" ? null : (opts.cutIndex ?? 2);
  const deps: ContextPolicyDeps = {
    thresholds: () => ({
      swap: SWAP,
      recut: RECUT,
      clamped: opts.clamped ?? false,
    }),
    nextAction,
    cutIndexFor: fakeCut === undefined ? cutIndexFor : () => fakeCut,
    cutMayReplace,
    frontier: () => opts.frontierNodes ?? (opts.summary ? [opts.summary] : []),
    spanBounds: arraySpanBounds,
    buildSynthetic,
    redact: opts.redact ?? ((text: string) => text),
  };
  return { result: applyContextPolicy(input, deps), rawMessages, deps };
}

function vineFrontier(): SummaryNode[] {
  const chain: SummaryNode = {
    id: 12,
    kind: "condensed",
    text: "c".repeat(16_000),
    tokens: 4000,
    depth: 8,
    firstEntryId: "e0",
    lastEntryId: "e1",
    createdAt: 0,
  };
  const leaves: SummaryNode[] = Array.from({ length: 25 }, (_, i) => ({
    id: 13 + i,
    kind: "leaf" as const,
    text: "l".repeat(400),
    tokens: 100,
    depth: 0,
    firstEntryId: "e0",
    lastEntryId: "e1",
    createdAt: 0,
  }));
  return [chain, ...leaves];
}

test("context policy: a re-applied boundary is not a new compaction", () => {
  const fresh = run({ occupancy: 0.8, cutIndex: 2, summary: summary("e1") });
  assert.equal(fresh.result.metrics[1]!.kind, "swap-applied");
  assert.equal(fresh.result.metrics[1]!.distinctBoundary, true);

  const same = run({
    occupancy: 0.9,
    commitState: pin(3),
    cutIndex: 3,
    summary: summary("e2"),
  });
  assert.equal(same.result.metrics[1]!.kind, "swap-applied");
  assert.equal(same.result.metrics[1]!.cutCount, 3);
  assert.equal(same.result.commitState?.cutCount, 3);
  assert.equal(same.result.metrics[1]!.distinctBoundary, false);

  const moved = run({
    occupancy: 0.9,
    commitState: pin(3),
    cutIndex: 4,
    summary: summary("e3"),
  });
  const swap = rowsOfKind(moved.result.metrics, "swap-applied")[0]!;
  assert.equal(swap.cutCount, 4);
  assert.equal(swap.distinctBoundary, true);
});

test("context policy: node text is masked on the way to the projection", () => {
  const secret = "sk-abcdefghijklmnop1234567890";
  const keyed = { ...summary("e1"), text: `the key is ${secret} here` };
  const masked = run({ summary: keyed, redact: redactSecrets });
  const content = masked.result.commitState!.synthetic.content;
  assert.ok(content.includes("[REDACTED]"), content);
  assert.ok(!content.includes(secret), "the key never reaches the projection");

  const plain = run({ summary: keyed, redact: (text: string) => text });
  assert.ok(plain.result.commitState!.synthetic.content.includes(secret));
});

test("context policy: every frontier node reaches the projection, stubbed not evicted", () => {
  const frontier = vineFrontier();
  const fits = run({
    occupancy: 0.8,
    cutIndex: 2,
    frontierNodes: frontier,
    summaryTokens: 3000,
  });
  const state = fits.result.commitState!;
  assert.equal(state.applied.length, frontier.length);
  assert.deepEqual(
    state.applied.map((n) => n.id),
    frontier.map((n) => n.id),
  );
  const rendered = renderSummaries(state.applied);
  for (const node of frontier)
    assert.ok(rendered.includes(`#${node.id} `), `node ${node.id} is named`);
  assert.equal(state.applied[0]!.tier, "stub", "the oldest node is the first to lose text");
  assert.equal(state.applied[25]!.tier, "rich", "the newest node keeps full text while it fits");
  const swap = fits.result.metrics.find((m) => m.kind === "swap-applied")!;
  assert.equal(swap.nodes, 26);
  assert.equal(swap.stubbed, 1);
  assert.equal(swap.budgetTokens, 3000);
  assert.ok(Number(swap.renderedTokens) <= 3000);
  assert.equal(
    fits.result.metrics.find((m) => m.kind === "projection-over-budget"),
    undefined,
    "a render that fits records nothing",
  );

  const tight = run({
    occupancy: 0.8,
    cutIndex: 2,
    frontierNodes: vineFrontier(),
    summaryTokens: 1500,
  });
  const tightBail = asOutcome(tight.result, "bail");
  assert.equal(tightBail.reason, "projection-over-budget");
  const over = tight.result.metrics.find((m) => m.kind === "projection-over-budget")!;
  assert.equal(over.nodes, 26);
  assert.equal(over.budgetTokens, 1500);
  assert.ok(Number(over.renderedTokens) > 1500);
  assert.equal(
    tight.result.metrics.some((m) => m.kind === "swap-applied"),
    false,
    "a projection over budget is not applied",
  );
  assert.equal(tight.result.commitState, null);
  assert.equal(
    asOutcome(tight.result, "bail").messages,
    undefined,
    "no pin to serve, so the turn keeps raw context",
  );

  const pinned = run({
    occupancy: 0.9,
    cutIndex: 2,
    commitState: pin(2),
    frontierNodes: vineFrontier(),
    summaryTokens: 1500,
  });
  const held = asOutcome(pinned.result, "bail");
  assert.equal(held.reason, "projection-over-budget");
  assert.deepEqual(held.messages?.[0], pin(2).synthetic);
});

test("context policy: the smallest stub case loses text from the oldest node only", () => {
  const frontier: SummaryNode[] = [
    { ...summary("e1"), id: 1, text: "a".repeat(2000) },
    { ...summary("e1"), id: 2, text: "b".repeat(2000) },
  ];
  const { result } = run({
    occupancy: 0.8,
    cutIndex: 2,
    frontierNodes: frontier,
    summaryTokens: 600,
  });
  const state = result.commitState!;
  assert.deepEqual(
    state.applied.map((n) => [n.id, n.tier]),
    [
      [1, "stub"],
      [2, "rich"],
    ],
  );
  const rendered = renderSummaries(state.applied);
  assert.ok(rendered.includes("#1 ") && rendered.includes("#2 "));
  assert.ok(rendered.includes("b".repeat(2000)), "the newest node keeps its whole text");
  assert.ok(!rendered.includes("a".repeat(2000)), "the oldest node's text is elided");
});

test("context policy: a budget smaller than the stub floor is refused", () => {
  const frontier: SummaryNode[] = [1, 2, 3, 4].map((i) => ({
    ...summary("e1"),
    id: i,
    text: `node ${i} `.padEnd(400, "x"),
  }));
  const { result } = run({
    occupancy: 0.8,
    cutIndex: 2,
    frontierNodes: frontier,
    summaryTokens: 0,
  });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "projection-over-budget");
  assert.equal(result.commitState, null);
  const over = result.metrics.find((m) => m.kind === "projection-over-budget")!;
  assert.equal(over.nodes, 4);
  assert.equal(over.budgetTokens, 0);
  assert.ok(Number(over.renderedTokens) > 0);
});

test("context policy: no frontier size and budget can shorten the projection", () => {
  for (let n = 1; n <= 12; n++) {
    for (const budget of [0, 50, 300, 5000, 1_000_000]) {
      const frontier: SummaryNode[] = Array.from({ length: n }, (_, i) => ({
        ...summary("e1"),
        id: i + 1,
        text: `node ${i} `.padEnd(600, "y"),
      }));
      const { result } = run({
        occupancy: 0.8,
        cutIndex: 2,
        frontierNodes: frontier,
        summaryTokens: budget,
      });
      const state = result.commitState;
      if (!state) {
        assert.equal(
          asOutcome(result, "bail").reason,
          "projection-over-budget",
          `${n} nodes at budget ${budget}`,
        );
        continue;
      }
      assert.equal(state.applied.length, n, `${n} nodes at budget ${budget} keep every pointer`);
    }
  }
});

test("context policy: a pinned projection re-renders byte-identically", () => {
  const frontier = vineFrontier();
  const first = run({ occupancy: 0.8, cutIndex: 2, frontierNodes: frontier, summaryTokens: 3000 });
  const pinned = first.result.commitState!;
  const second = run({
    occupancy: 0.8,
    cutIndex: 2,
    frontierNodes: vineFrontier(),
    summaryTokens: 3000,
  });
  assert.equal(second.result.commitState!.synthetic.content, pinned.synthetic.content);
  const stable = run({
    occupancy: 0.78,
    cutIndex: 2,
    commitState: pinned,
    frontierNodes: frontier,
  });
  assert.equal(stable.result.commitState!.synthetic.content, pinned.synthetic.content);
  assert.ok(pinned.synthetic.content.includes("lcm_describe"));
});

test("context policy: an unstubbed projection is byte-identical to the pre-stub render", () => {
  const s = summary("e1");
  const { result } = run({ occupancy: 0.8, cutIndex: 2, summary: s, summaryTokens: 5000 });
  assert.equal(
    result.commitState!.synthetic.content,
    `${SYNTHETIC_MARKER}: earlier conversation is compacted into the summaries below. ` +
      "Originals are recoverable verbatim: lcm_expand_query(query, prompt) reads them from the store, lcm_grep(query) finds them.\n\n" +
      `[lcm:summary #1 depth 0 span e0..e1]\nsummary text`,
  );
  assert.equal(result.commitState!.applied[0]!.tier, "rich");
});

test("context policy: quiet below swap: no messages, no state change", () => {
  const { result } = run({ occupancy: 0.5 });
  assert.equal(result.outcome, "quiet");
  assert.equal(result.commitState, null);
  assert.equal(result.clampWarning, undefined);
  assert.equal(result.metrics.length, 1);
  assert.equal(result.metrics[0]!.kind, "context-decision");
  assert.equal(result.metrics[0]!.action, "quiet");
  assert.equal(result.metrics[0]!.committed, false);
});

test("context policy: only the kick outcome carries a span to compact", () => {
  const kick = run({ occupancy: 0.8, cutIndex: 2, summary: undefined }).result;
  assert.equal(kick.outcome, "kick");
  assert.deepEqual(
    asOutcome(kick, "kick").aged.map((e) => e.entryId),
    ["e0", "e1"],
  );
  const onlyKickCarriesAged = (
    outcome: Extract<ContextPolicyResult, { aged: unknown }>["outcome"],
  ): "kick" => outcome;
  assert.equal(onlyKickCarriesAged("kick"), "kick");
});

test("context policy: consider-apply applies a swap at the aged boundary", () => {
  const s = summary("e1");
  const { result, rawMessages } = run({ occupancy: 0.8, cutIndex: 2, summary: s });
  const swapped = asOutcome(result, "swap");
  assert.equal(swapped.messages.length, 5);
  assert.ok(swapped.messages[0]!.role === "user");
  assert.ok(
    typeof swapped.messages[0]!.content === "string" &&
      swapped.messages[0]!.content.includes(SYNTHETIC_MARKER),
  );
  assert.deepEqual(swapped.messages.slice(1), rawMessages.slice(2));
  assert.equal(result.commitState?.cutCount, 2);
  assert.equal(result.commitState?.summaryId, 1);
  assert.equal(result.metrics.length, 2);
  assert.equal(result.metrics[0]!.kind, "context-decision");
  assert.equal(result.metrics[1]!.kind, "swap-applied");
  assert.equal(result.metrics[1]!.cutCount, 2);
});

test("context policy: stable re-applies the frozen pin on every call", () => {
  const pinState = pin(3);
  const { result, rawMessages } = run({
    occupancy: 0.75,
    commitState: pinState,
    summary: summary("e2"),
  });
  const reapplied = asOutcome(result, "reapply");
  assert.equal(reapplied.messages.length, 4);
  assert.equal(reapplied.messages[0], pinState.synthetic);
  assert.deepEqual(reapplied.messages.slice(1), rawMessages.slice(3));
  assert.equal(result.commitState, pinState);
  assert.equal(result.metrics.length, 1);
  assert.equal(result.metrics[0]!.kind, "context-decision");
});

test("context policy: the pin survives appended turns and keeps the same first kept message", () => {
  const s = summary("e1");
  const first = run({ occupancy: 0.8, cutIndex: 2, summary: s, entryCount: 6 }).result;
  assert.equal(first.commitState?.cutCount, 2);
  const pinState = first.commitState!;

  for (const n of [6, 8, 10]) {
    const { result, rawMessages } = run({
      occupancy: 0.75,
      commitState: pinState,
      entryCount: n,
    });
    const reapplied = asOutcome(result, "reapply");
    assert.equal(result.commitState, pinState, `n=${n}`);
    assert.equal(reapplied.messages.length, n - 2 + 1, `n=${n}`);
    assert.equal(reapplied.messages[0], pinState.synthetic);
    assert.deepEqual(reapplied.messages.slice(1), rawMessages.slice(2), `n=${n}`);
    assert.deepEqual(reapplied.messages[1], { role: "user", content: "message 2" });
  }
});

test("context policy: a pin whose cut equals the tail length is tail-shrunk, not indexed past the end", () => {
  const { result } = run({ occupancy: 0.75, commitState: pin(6), entryCount: 6 });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "tail-shrunk");
  assert.equal(bail.commitState, null);
});

test("context policy: a session with one user turn swaps instead of bailing on the cut", () => {
  const raw = [
    { role: "user", content: "task ".repeat(200) },
    ...Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "assistant" : "toolResult",
      content: `chunk ${i} `.repeat(200),
    })),
  ];
  const ctxEntries: AlignedEntry[] = raw.map((m, i) => ({
    entryId: `e${i}`,
    role: m.role,
    text: m.content,
  }));
  const cut = cutIndexFor(raw, 300);
  assert.ok(cut !== null && cut > 0, `the cut must be above the session start, got ${cut}`);
  const input: ContextPolicyInput = {
    rawMessages: raw,
    getCtxEntries: () => ctxEntries,
    occupancy: 0.8,
    tokens: 800_000,
    contextWindow: WINDOW,
    modelKey: "test/model",
    thresholds: {},
    keepRecentTokens: 300,
    summaryTokens: 1500,
    clampNotified: false,
    commitState: null,
    pinnedModelKey: "test/model",
    pinnedWindow: WINDOW,
  };
  const deps: ContextPolicyDeps = {
    thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
    nextAction,
    cutIndexFor,
    cutMayReplace,
    frontier: (a, b) => (a === "e0" && b === `e${cut - 1}` ? [summary(`e${cut - 1}`)] : []),
    spanBounds: arraySpanBounds,
    buildSynthetic,
    redact: (text: string) => text,
  };
  const result = applyContextPolicy(input, deps);
  const swapped = asOutcome(result, "swap");
  assert.equal(swapped.messages[0]!.role, "user");
  assert.equal(result.commitState?.cutCount, cut);
});

test("context policy: a whole-session tool tail with no boundary above the start bails with no-boundary", () => {
  const messages: AssemblyMsg[] = [
    { role: "user", content: "u0" },
    ...Array.from({ length: 100 }, () => ({ role: "toolResult", content: "t".repeat(1000) })),
  ];
  const { result } = run({ occupancy: 0.9, messages, cutIndex: "real" });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "no-boundary");
  assert.equal(bail.commitState, null);
});

test("context policy: a walk that finds no cut point bails with no-boundary", () => {
  const { result } = run({ occupancy: 0.9, cutIndex: "none" });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "no-boundary");
  assert.equal(bail.commitState, null);
});

test("context policy: a cut at the session start bails with nothing-to-age", () => {
  const { result } = run({ occupancy: 0.8, cutIndex: 0 });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "nothing-to-age");
  assert.equal(bail.commitState, null);
});

test("context policy: a recommit that bails keeps serving the existing pin", () => {
  const pinState = pin(2);
  const { result, rawMessages } = run({
    occupancy: 0.9,
    commitState: pinState,
    cutIndex: 4,
    summary: undefined,
    entryCount: 8,
  });
  const kick = asOutcome(result, "kick");
  assert.deepEqual(
    kick.aged.map((e) => e.entryId),
    ["e0", "e1", "e2", "e3"],
  );
  assert.equal(kick.commitState, pinState);
  assert.deepEqual(kick.messages, [pinState.synthetic, ...rawMessages.slice(2)]);
  assert.deepEqual(
    rowsOfKind(result.metrics, "context-decision").map((m) => [m.kind, m.action]),
    [["context-decision", "recommit"]],
  );
});

test("context policy: a recommit onto a foreign tail drops the pin before re-cutting", () => {
  const pinState = pin(2);
  const foreign = rawMsgs(8).map((m, i) => ({ ...m, content: `foreign ${i}` }));
  const result = applyContextPolicy(
    {
      rawMessages: foreign,
      getCtxEntries: () => entries(8),
      occupancy: 0.9,
      tokens: 900_000,
      contextWindow: WINDOW,
      modelKey: "test/model",
      thresholds: {},
      keepRecentTokens: 20_000,
      summaryTokens: 1500,
      clampNotified: false,
      commitState: pinState,
      pinnedModelKey: "test/model",
      pinnedWindow: WINDOW,
    },
    {
      thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
      nextAction,
      cutIndexFor: () => 4,
      cutMayReplace,
      frontier: () => [],
      spanBounds: arraySpanBounds,
      buildSynthetic,
      redact: (text: string) => text,
    },
  );
  const bail = asOutcome(result, "bail");
  assert.equal(bail.reason, "tail-mismatch");
  assert.equal(bail.commitState, null);
  assert.equal(bail.messages, undefined);
});

test("context policy: tail shrank below the pinned cut: pin dropped, bail-safe", () => {
  const pinState = pin(10);
  const { result } = run({ occupancy: 0.75, commitState: pinState });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.messages, undefined);
  assert.equal(bail.commitState, null);
  assert.equal(bail.reason, "tail-shrunk");
  assert.deepEqual(
    rowsOfKind(result.metrics, "context-decision").map((m) => [m.kind, m.action, m.committed]),
    [["context-decision", "stable", true]],
  );
});

test("context policy: recommit with a smaller cut is refused, pin kept and served", () => {
  const pinState = pin(5);
  const { result, rawMessages } = run({
    occupancy: 0.9,
    commitState: pinState,
    cutIndex: 2,
    summary: summary("e1"),
  });
  const bail = asOutcome(result, "bail");
  assert.deepEqual(bail.messages, [pinState.synthetic, ...rawMessages.slice(5)]);
  assert.equal(bail.commitState, pinState);
  assert.equal(bail.reason, "monotonic-refused");
});

test("context policy: missing summary at the boundary kicks async compaction", () => {
  const { result } = run({ occupancy: 0.8, cutIndex: 2, summary: undefined });
  const kick = asOutcome(result, "kick");
  assert.equal(kick.messages, undefined);
  assert.equal(kick.commitState, null);
  assert.deepEqual(
    kick.aged.map((e) => e.entryId),
    ["e0", "e1"],
  );
  assert.equal(kick.metrics.length, 1);
});

test("context policy: clamp warning fires exactly once", () => {
  const first = run({ clamped: true, clampNotified: false }).result;
  assert.ok(first.clampWarning);
  assert.ok(first.clampWarning!.includes("clamped to swap 70% / recut 85%"));
  assert.equal(first.clampNotified, true);
  const second = run({ clamped: true, clampNotified: first.clampNotified }).result;
  assert.equal(second.clampWarning, undefined);
  const silent = run({ clamped: true, clampNotified: true }).result;
  assert.equal(silent.clampWarning, undefined);
});

test("context policy: model change drops the pinned projection", () => {
  const pinState = pin(3);
  const { result } = run({
    occupancy: 0.75,
    commitState: pinState,
    modelKey: "other/model",
    pinnedModelKey: "test/model",
  });
  assert.equal(rowsOfKind(result.metrics, "context-decision")[0]!.action, "consider-apply");
  const withSummary = run({
    occupancy: 0.75,
    commitState: pinState,
    modelKey: "other/model",
    pinnedModelKey: "test/model",
    summary: summary("e1"),
  }).result;
  assert.notEqual(asOutcome(withSummary, "swap").messages[0], pinState.synthetic);
  const noSummary = run({
    occupancy: 0.75,
    commitState: pinState,
    modelKey: "other/model",
    pinnedModelKey: "test/model",
    summary: undefined,
  }).result;
  assert.equal(asOutcome(noSummary, "kick").messages, undefined);
});

test("context policy: window change drops the pinned projection too", () => {
  const pinState = pin(3);
  const { result } = run({ occupancy: 0.75, commitState: pinState, pinnedWindow: 500_000 });
  assert.equal(result.commitState, null);
  assert.equal(rowsOfKind(result.metrics, "context-decision")[0]!.action, "consider-apply");
  assert.equal(asOutcome(result, "kick").reason, "summary-missing");
  assert.equal(result.pinnedWindow, WINDOW);
});

test("stable pin: tail identity mismatch clears the pin", () => {
  const pinState = pin(3);
  const foreign = rawMsgs(6).map((m, i) => ({ ...m, content: `foreign ${i}` }));
  const input: ContextPolicyInput = {
    rawMessages: foreign,
    getCtxEntries: () => entries(6),
    occupancy: 0.75,
    tokens: 750_000,
    contextWindow: WINDOW,
    modelKey: "test/model",
    thresholds: {},
    keepRecentTokens: 20_000,
    summaryTokens: 1500,
    clampNotified: false,
    commitState: pinState,
    pinnedModelKey: "test/model",
    pinnedWindow: WINDOW,
  };
  const result = applyContextPolicy(input, {
    thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
    nextAction,
    cutIndexFor: () => 2,
    cutMayReplace,
    frontier: () => [summary("e1")],
    spanBounds: arraySpanBounds,
    buildSynthetic,
    redact: (text: string) => text,
  });
  const bail = asOutcome(result, "bail");
  assert.equal(bail.commitState, null);
  assert.equal(bail.messages, undefined);
  assert.equal(bail.reason, "tail-mismatch");
  assert.deepEqual(
    rowsOfKind(result.metrics, "context-decision").map((m) => [m.kind, m.action, m.committed]),
    [["context-decision", "stable", true]],
  );
});

test("stable pin: matching tail identity re-applies the pin", () => {
  const pinState = pin(3);
  const { result, rawMessages } = run({ occupancy: 0.75, commitState: pinState });
  assert.equal(result.commitState, pinState);
  assert.deepEqual(asOutcome(result, "reapply").messages.slice(1), rawMessages.slice(3));
  assert.equal(result.commitState?.tailKey, JSON.stringify(["assistant", "message 3"]));
});

test("tailKeyOf: block-array content keys on its text, not [object Object]", () => {
  const a = tailKeyOf({ role: "user", content: [{ type: "text", text: "first tail" }] });
  const b = tailKeyOf({ role: "user", content: [{ type: "text", text: "second tail" }] });
  assert.equal(a, JSON.stringify(["user", "first tail"]));
  assert.notEqual(a, b);
  assert.equal(tailKeyOf({ role: "user", content: "plain" }), JSON.stringify(["user", "plain"]));
  assert.equal(tailKeyOf({ role: "user" }), JSON.stringify(["user", ""]));
});

const spanBranch: AlignedEntry[] = [
  { entryId: "a", role: "user", text: "hello" },
  { entryId: "b", role: "bashExecution", text: "$ ls\nfile.txt" },
  { entryId: "c", role: "assistant", text: "hi there" },
  { entryId: "d", role: "user", text: "continue" },
  { entryId: "e", role: "user", text: "continue" },
];

test("resolveCompactionSpan: everything before firstKeptEntryId, by id, in branch order", () => {
  const span = resolveCompactionSpan(spanBranch, { firstKeptEntryId: "d" });
  assert.deepEqual(
    span.map((e) => e.entryId),
    ["a", "b", "c"],
  );
  assert.deepEqual(span[1], { entryId: "b", role: "bashExecution", text: "$ ls\nfile.txt" });
});

test("resolveCompactionSpan: identical texts on both sides of the cut do not leak the kept one", () => {
  const span = resolveCompactionSpan(spanBranch, { firstKeptEntryId: "e" });
  assert.deepEqual(
    span.map((e) => e.entryId),
    ["a", "b", "c", "d"],
  );
});

test("resolveCompactionSpan: starts at the previous compaction's first kept entry and skips the compaction row", () => {
  const branch: AlignedEntry[] = [
    { entryId: "old1", role: "user", text: "already summarized" },
    { entryId: "k1", role: "user", text: "kept by compaction 1" },
    { entryId: "k2", role: "assistant", text: "kept too" },
    { entryId: "cmp1", role: "compactionSummary", text: "summary of old1" },
    { entryId: "n1", role: "user", text: "after compaction" },
    { entryId: "n2", role: "assistant", text: "tail" },
  ];
  const span = resolveCompactionSpan(branch, { startEntryId: "k1", firstKeptEntryId: "n2" });
  assert.deepEqual(
    span.map((e) => e.entryId),
    ["k1", "k2", "n1"],
  );
});

test("resolveCompactionSpan: first kept entry is the first entry, or unknown, yields an empty span", () => {
  assert.deepEqual(resolveCompactionSpan(spanBranch, { firstKeptEntryId: "a" }), []);
  assert.deepEqual(resolveCompactionSpan(spanBranch, { firstKeptEntryId: "nope" }), []);
  assert.deepEqual(
    resolveCompactionSpan(spanBranch, { startEntryId: "nope", firstKeptEntryId: "c" }).map(
      (e) => e.entryId,
    ),
    ["a", "b"],
  );
});

test("context policy: real cut pipeline end-to-end lands on a user boundary", () => {
  const big = rawMsgs(20).map((m) => ({ ...m, content: m.content.repeat(20) }));
  const input: ContextPolicyInput = {
    rawMessages: big,
    getCtxEntries: () => entries(20),
    occupancy: 0.8,
    tokens: 800_000,
    contextWindow: WINDOW,
    modelKey: "test/model",
    thresholds: {},
    keepRecentTokens: 300,
    summaryTokens: 1500,
    clampNotified: false,
    commitState: null,
    pinnedModelKey: "test/model",
    pinnedWindow: WINDOW,
  };
  const deps: ContextPolicyDeps = {
    thresholds: effectiveThresholds,
    nextAction,
    cutIndexFor,
    cutMayReplace,
    frontier: (a, b) => (a === "e0" && b === "e13" ? [summary("e13")] : []),
    spanBounds: arraySpanBounds,
    buildSynthetic,
    redact: (text: string) => text,
  };
  const result = applyContextPolicy(input, deps);
  const swapped = asOutcome(result, "swap");
  assert.equal(swapped.messages[0]!.role, "user");
  assert.equal(
    swapped.messages[0]!.content,
    `${SYNTHETIC_MARKER}: earlier conversation is compacted into the summaries below. ` +
      "Originals are recoverable verbatim: lcm_expand_query(query, prompt) reads them from the store, lcm_grep(query) finds them.\n\n" +
      "[lcm:summary #1 depth 0 span e0..e13]\nsummary text",
  );
  assert.equal(result.commitState?.cutCount, 14);
  assert.equal(swapped.messages.length, 7);
  assert.deepEqual(swapped.messages.slice(1), big.slice(14));
  assert.deepEqual(
    result.metrics.map((m) => [
      m.kind,
      m.kind === "context-decision" ? m.action : m.kind === "swap-applied" ? m.cutCount : undefined,
    ]),
    [
      ["context-decision", "consider-apply"],
      ["swap-applied", 14],
    ],
  );
});

test("policy: a compaction entry at the head of the aged set is not the span's first end", () => {
  const s = new LcmStore(":memory:");
  for (const id of ["e0", "e1", "e2", "e3", "c1"]) {
    s.insertMessage({ entryId: id, role: "user", text: id, tokens: 1, timestamp: 0 });
  }
  const ctxEntries: AlignedEntry[] = [
    { entryId: "c1", role: "compactionSummary", text: "pi summary" },
    ...entries(4),
  ];
  const asked: Array<[string, string]> = [];
  const result = applyContextPolicy(
    {
      rawMessages: rawMsgs(5),
      getCtxEntries: () => ctxEntries,
      occupancy: 0.9,
      tokens: 900_000,
      contextWindow: WINDOW,
      modelKey: "test/model",
      thresholds: {},
      keepRecentTokens: 20_000,
      summaryTokens: 1500,
      clampNotified: false,
      commitState: null,
      pinnedModelKey: "test/model",
      pinnedWindow: WINDOW,
    },
    {
      thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
      nextAction,
      cutIndexFor: () => 3,
      cutMayReplace,
      frontier: (first, last) => {
        asked.push([first, last]);
        return first === "e0" && last === "c1" ? [summary("c1")] : [];
      },
      spanBounds: (aged) => s.spanBounds(aged.map((entry) => entry.entryId)),
      buildSynthetic,
      redact: (text: string) => text,
    },
  );
  assert.deepEqual(asked, [["e0", "c1"]]);
  assert.equal(result.outcome, "swap");
  assert.equal(result.commitState?.cutCount, 3);
  s.close();
});

test("policy: an aged set the store holds none of bails instead of kicking", () => {
  const result = applyContextPolicy(
    {
      rawMessages: rawMsgs(3),
      getCtxEntries: () => entries(3).map((entry) => ({ ...entry, text: "   " })) as AlignedEntry[],
      occupancy: 0.9,
      tokens: 900_000,
      contextWindow: WINDOW,
      modelKey: "test/model",
      thresholds: {},
      keepRecentTokens: 20_000,
      summaryTokens: 1500,
      clampNotified: false,
      commitState: null,
      pinnedModelKey: "test/model",
      pinnedWindow: WINDOW,
    },
    {
      thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
      nextAction,
      cutIndexFor: () => 2,
      cutMayReplace,
      frontier: () => {
        throw new Error("a bail must not ask for a frontier");
      },
      spanBounds: () => null,
      buildSynthetic,
      redact: (text: string) => text,
    },
  );
  assert.equal(result.outcome, "bail");
  assert.equal(result.reason, "aged-unstored");
});

test("backoff: kick allowed until 3 attempts within the backoff window", () => {
  const now = 1_000_000;
  assert.equal(shouldKickBoundary(undefined, now), true);
  assert.equal(shouldKickBoundary({ attempts: 1, lastAt: now }, now), true);
  assert.equal(shouldKickBoundary({ attempts: 2, lastAt: now }, now), true);
  assert.equal(shouldKickBoundary({ attempts: 3, lastAt: now - 1000 }, now), false);
  assert.equal(shouldKickBoundary({ attempts: 3, lastAt: now - KICK_BACKOFF_MS - 1 }, now), true);
  assert.equal(shouldKickBoundary({ attempts: 4, lastAt: now }, now), false);
});

function summaryNode(
  id: number,
  text: string,
  span: [string, string] = ["e0", `e${id}`],
  depth = 0,
): SummaryNode {
  return {
    id,
    kind: depth > 0 ? "condensed" : "leaf",
    text,
    tokens: 10,
    depth,
    firstEntryId: span[0],
    lastEntryId: span[1],
    createdAt: 0,
  };
}

function recommitDeps(frontier: ContextPolicyDeps["frontier"]): ContextPolicyDeps {
  return {
    thresholds: () => ({ swap: SWAP, recut: RECUT, clamped: false }),
    nextAction,
    cutIndexFor: () => 3,
    cutMayReplace,
    frontier,
    spanBounds: arraySpanBounds,
    buildSynthetic,
    redact: (text: string) => text,
  };
}

function recommitInput(commitState: CommitState | null): ContextPolicyInput {
  return {
    rawMessages: rawMsgs(6),
    getCtxEntries: () => entries(6),
    occupancy: 0.9,
    tokens: 900_000,
    contextWindow: WINDOW,
    modelKey: "test/model",
    thresholds: {},
    keepRecentTokens: 20_000,
    summaryTokens: 1500,
    clampNotified: false,
    commitState,
    pinnedModelKey: "test/model",
    pinnedWindow: WINDOW,
  };
}

test("recommit: the projection is the frontier, oldest first, every node rendered with its id", () => {
  const asked: Array<[string, string]> = [];
  const result = applyContextPolicy(
    recommitInput(null),
    recommitDeps((a, b) => {
      asked.push([a, b]);
      return [
        summaryNode(1, "summary ONE", ["e0", "e0"]),
        summaryNode(2, "summary TWO", ["e1", "e1"]),
        summaryNode(3, "summary THREE", ["e2", "e2"]),
      ];
    }),
  );
  assert.deepEqual(asked, [["e0", "e2"]]);
  assert.deepEqual(
    result.commitState?.applied.map((a) => a.id),
    [1, 2, 3],
  );
  assert.equal(result.commitState?.summaryId, 3);
  const content = result.commitState?.synthetic.content;
  assert.ok(typeof content === "string");
  assert.ok(content.includes("[lcm:summary #1 depth 0 span e0..e0]\nsummary ONE"), content);
  assert.ok(content.includes("[lcm:summary #2 depth 0 span e1..e1]\nsummary TWO"), content);
  assert.ok(content.includes("[lcm:summary #3 depth 0 span e2..e2]\nsummary THREE"), content);
});

test("recommit: a frontier that stops short of the boundary kicks compaction of the aged span", () => {
  const result = applyContextPolicy(
    recommitInput(null),
    recommitDeps(() => [summaryNode(1, "summary ONE", ["e0", "e1"])]),
  );
  const kick = asOutcome(result, "kick");
  assert.equal(kick.commitState, null);
  assert.deepEqual(
    kick.aged.map((e) => e.entryId),
    ["e0", "e1", "e2"],
  );
});

test("recommit: a token cap no projection can meet is refused, and a met one keeps both pointers", () => {
  const capped = applyContextPolicy(
    { ...recommitInput(null), summaryTokens: 5 },
    recommitDeps(() => [
      summaryNode(1, "summary ONE", ["e0", "e1"]),
      summaryNode(2, "summary TWO", ["e2", "e2"]),
    ]),
  );
  assert.equal(asOutcome(capped, "bail").reason, "projection-over-budget");
  assert.equal(capped.commitState, null);
  assert.ok(capped.metrics.some((m) => m.kind === "projection-over-budget"));

  const fits = applyContextPolicy(
    { ...recommitInput(null), summaryTokens: 300 },
    recommitDeps(() => [
      summaryNode(1, "summary ONE", ["e0", "e1"]),
      summaryNode(2, "summary TWO", ["e2", "e2"]),
    ]),
  );
  assert.equal(fits.commitState?.applied.length, 2);
  const rendered = renderSummaries(fits.commitState?.applied ?? []);
  assert.ok(rendered.includes("#1 ") && rendered.includes("#2 "), "no pointer is dropped");
});

test("recommit: a condensed node replaces its children in the projection (real store frontier)", () => {
  const store = new LcmStore(":memory:");
  ingestEntries(
    store,
    Array.from({ length: 6 }, (_, i) => ({
      entryId: `e${i}`,
      role: "user" as const,
      text: `m${i}`,
      timestamp: i + 1,
    })),
  );
  const leaf = (first: string, last: string, text: string) =>
    store.insertSummary({
      kind: "leaf",
      text,
      tokens: 3,
      depth: 0,
      firstEntryId: first,
      lastEntryId: last,
      messageIds: store.messagesInSpan(first, last).map((m) => m.id),
    }).id;
  const l1 = leaf("e0", "e1", "leaf one");
  const l2 = leaf("e2", "e2", "leaf two");
  const deps = recommitDeps(store.frontier.bind(store));
  const first = applyContextPolicy(recommitInput(null), deps);
  assert.deepEqual(
    first.commitState?.applied.map((a) => a.id),
    [l1, l2],
  );
  const c = store.insertSummary({
    kind: "condensed",
    text: "condensed",
    tokens: 2,
    depth: 1,
    firstEntryId: "e0",
    lastEntryId: "e2",
    childSummaryIds: [l1, l2],
  }).id;
  const second = applyContextPolicy(recommitInput(first.commitState), deps);
  assert.deepEqual(
    second.commitState?.applied.map((a) => [a.id, a.depth]),
    [[c, 1]],
  );
  assert.equal(second.commitState?.summaryId, c);
  store.close();
});

test("context policy: a node with a richer sibling is served terse before it is stubbed", () => {
  const thorough = "thorough ".repeat(50).trim();
  const node: SummaryNode = {
    ...summary("e1"),
    id: 1,
    text: "terse version",
    tokens: 4,
    thoroughText: thorough,
    thoroughTokens: 112,
  };
  const nodeOf = (summaryTokens: number) =>
    run({ occupancy: 0.8, cutIndex: 2, frontierNodes: [node], summaryTokens }).result;
  const roomy = nodeOf(200).commitState!;
  assert.equal(roomy.applied[0]!.tier, "rich");
  assert.ok(roomy.synthetic.content.includes("thorough thorough"));
  const tight = nodeOf(30).commitState!;
  assert.equal(tight.applied[0]!.tier, "terse");
  assert.ok(tight.synthetic.content.includes("terse version"));
  assert.equal(tight.synthetic.content.includes("thorough"), false);
  assert.equal(tight.synthetic.content.includes("lcm:stub"), false, "not stubbed");
  const none = nodeOf(1);
  assert.equal(asOutcome(none, "bail").reason, "projection-over-budget");
  assert.equal(none.commitState, null);
  for (const state of [roomy, tight]) {
    assert.ok(state.synthetic.content.includes("[lcm:summary #1 depth 0 span e0..e1]"));
  }
});
