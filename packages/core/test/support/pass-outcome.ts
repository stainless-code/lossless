import assert from "node:assert/strict";

import {
  runCompaction,
  type CompactionInput,
  type CompactionOutcome,
} from "../../src/compaction-engine.ts";
import type { PassStore } from "../../src/store.ts";
import type { LlmComplete } from "../../src/summarize.ts";

export async function storedPass(
  store: PassStore,
  input: CompactionInput,
  llm: LlmComplete,
  opts?: Parameters<typeof runCompaction>[3],
): Promise<Extract<CompactionOutcome, { kind: "stored" }>> {
  const outcome = await runCompaction(store, input, llm, opts);
  assert.equal(outcome.kind, "stored", `pass outcome ${outcome.kind}`);
  return outcome as Extract<CompactionOutcome, { kind: "stored" }>;
}
