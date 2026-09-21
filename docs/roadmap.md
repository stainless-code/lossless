# Roadmap

Forward-looking work only. What the current release does is in the
[README](../README.md) and on the
[docs site](https://stainless-code.com/lossless/); behavior lives in the code,
and the peer comparison with its verified cells is in
[`COMPARISON.md`](../apps/docs/COMPARISON.md). Each item below names the evidence
that would close it and what it costs. Nothing here is built before it has a
measurement or a defect behind it.

## Paper conformance

The mechanism is in [how it works](../apps/docs/content/concepts/how-it-works.mdx).
Where this implementation departs from the paper, and what it does not claim:

**Accepted deviations**

- **Level 2 keeps level 1's output budget** rather than a fraction of it. A
  smaller cap makes a reasoning model likelier to answer nothing, and level 3
  already covers the floor.
- **Raw expansion is delegated** instead of running in the main loop. The paper
  restricts its expand tool to a sub-agent it spawns; Pi core has no task tool,
  so `lcm_expand_query` runs an in-process reader with its own context, a token
  budget (default 10,000), a turn cap (6), and read-only store access. It
  returns findings, and a windowed read pages inside a single message, so no
  stored character is unreachable.
- **A lone over-budget node is reduced in place.** The paper replaces a block in
  the active context with a pointer to a newly stored summary, so the DAG grows;
  this build re-summarizes the node's own text on the terse rung, keeps its id,
  kind and depth, and stores the answer only if it is much smaller. The paper's
  taxonomy names a leaf as a summary of a span of messages and a condensed node
  as a summary of several summaries, so this node is a second-generation summary
  of itself that the paper does not name. The invariant holds: the node keeps
  every pointer to its children, which keeps the originals reachable.
- **The depth cap (8) is a structural assert, not a tuning policy.** With fanout
  8 it covers 8^8 leaf chunks, and a pass that cannot meet its budget records
  `condensation-stalled` instead of stopping silently.
- **A node keeps a second, richer tier of its own text.** The paper stores one
  text per node; this build stores the thorough rung beside a terse one and
  serves the richest that fits the projection's budget. One id, one span, every
  child pointer, so the originals stay reachable.
- **Large-body externalization keeps the bytes and adds a handle.** A tool
  result above `largeFileChars` whose call named a path keeps its verbatim text,
  and a descriptor (path, content id, the kind the body turned out to be, an
  exploration summary, and a bounded head of the body) is stored beside it. Two
  deliberate differences: externalized does not mean the bytes left the message
  row, because storage is already verbatim and a second blob store would add a
  thing that can go missing without removing anything; and the trigger is a path
  named by the tool call, because a size heuristic mislabels a large paste as a
  file and invents a path the message does not carry.
- **A descriptor's summary is extracted by rule**, never by a model or a parser,
  because the descriptor has to be built at ingest, where a provider call would
  be a cost on every large tool result. Code names its top-level declarations
  per family, JSON its shape plus one level of nesting, JSONL its row keys, a
  table its columns, Markdown its headings, and text its size and first line.

**Conformance gaps**

- `llm_map`, `agentic_map`, and scope-reduction delegation are not implemented.
  Paper §4.3 attributes its OOLONG advantage chiefly to LLM-Map, so those
  numbers are not claimed here and no campaign reproduces them.

## Open work

1. **The long-context evaluation is the evidence generator, and it measures
   retrieval, not summary quality.** Its summarizer is mechanical by design, so
   a paraphrase-based needle (rather than a key-value line) is a different
   generator. This is the first item to build, because it is the only source of
   measured evidence for the rest of this list.
2. **Cross-session recall, phase 2: a per-session digest index.** Gated on a
   measurement that asks for it. A search walks at most 20 stores under a
   1.5-second deadline and stops at 40 hits, so one call already covers a fixed
   slice of the archive, and what an index would buy is reach beyond those caps.
   What defers the index is unchanged: a second copy of summary text needs
   invalidation rules. This is the largest gap a peer review
   found and no audited peer closes it, so it is a 0.2.0 headline rather than
   0.1.0 material, and its benefit is unmeasurable until item 1 exists.
3. **C2: deterministic briefs against LLM summaries.** No published peer
   benchmark establishes that runtime-written deterministic briefs match LLM DAG
   summaries (the one that exists has 1 to 4 runs per condition, author-built and
   author-scored; see [`COMPARISON.md`](../apps/docs/COMPARISON.md)). Protocol:
   corpora are our own long session transcripts; arms are the host default, this
   build's LLM DAG, this build's deterministic briefs, and the
   deterministic-folding peer; metrics are recall accuracy on withheld
   early-session questions, fresh against cached input tokens, wall clock, and
   summarizer spend; the bar is to replace LLM summaries only if recall is
   indistinguishable across multiple sessions and cost is meaningfully lower.
4. **C3: overflow rollback.** A cleaner overflow recovery than falling back to
   the host's default compaction: branch the session leaf back to the last
   transmissible message, compact, then retry. Adopt only if overflow frequency
   matters, and note that the rollback rewrites the window, so it belongs at a
   commit boundary.
5. **Token estimation.** A model that reports no usage keeps the constant ratio,
   and a model switch mid-session keeps the previous session's ratio until the
   store reopens.
6. **The believed window.** A corrected window still reads whatever
   `ctx.getContextUsage()` reports, so the open question is whether the host
   should report a figure it has not measured. Separating a resume from a model
   switch as the trigger still needs a reproduction; the guard covers both
   because it reads the context rather than the triggers.
7. **Summarizer spend.** Both caps rest on one session's measurements, and a
   per-turn cap is a different decision from a per-pass one. A provider that
   alternates failure and success is never capped by the per-pass failure
   counter, because a usable answer resets it, and a span remembered for a
   minute is probed again after it.
8. **The stub floor.** A 20-node frontier costs about 1,650 tokens at any budget,
   because a stub is about 79 tokens (a 200-character preview, the elision
   marker, and the header). Condensing further or a cheaper stub both move a
   paper property rather than a number.
9. **A claimed range.** A range another live run claimed is still paid for
   before the claim is known.
10. **A second consumer.** Reopening this is an owner decision, plus the harness
    facts that decide it: the peer harnesses' compaction hooks are append-only
    where Pi's can replace the result, and the source check run on OpenCode's
    hook came back low-confidence, so that stays a question to answer before any
    work rather than a finding to build on. Until then `COMPARISON.md` stays
    Pi-only and no second adapter is written.
11. **The gallery asset, at release.** A `video` (mp4, hover-autoplay) or
    `image` field per the Pi packages documentation: a long session, context
    filling, the swap notification, then `lcm_expand_query` recovering verbatim
    content. Highest-leverage item for adoption, zero functional ROI.

## Considered and deferred

Each of these was verified in peer source and is worth doing only with a reason.

- **Idempotent ingest as one statement** (`UNIQUE(..., dedup_hash)` plus
  `INSERT ... SELECT MAX(seq)+1 ... ON CONFLICT DO NOTHING`) removes a
  check-then-insert race. Ours already dedups on a unique key; revisit only if a
  live race is observed.
- **Branch sweep as a catch-up** for a dropped ingest hook. Deferred because the
  `turn_end` batch plus the `session_start` backfill already recover the same
  ground, and a sweep is only worth its cost if a real gap is seen.
- **Ancestry-based branch invalidation** (require a node's producer branch head
  and its replacement boundary to still be in the active ancestry). Deferred
  until branch navigation produces a wrong read in real use.
- **Deterministic repair before falling back** (drop the bullets that carry an
  unsupported exact value, then re-validate). Deferred behind the token
  accounting, because a repair loop is only worth having once the accounting it
  feeds is sound.
- **A files-touched manifest injected as engine-computed ground truth**, with an
  incomplete-coverage flag. Deferred: it is the largest item here and it needs
  the long-context evaluation to show it helps.
- **Post-compaction damage detection** (score re-reads of just-compacted paths,
  repeated questions, contradictions). Deferred behind the evaluation for the
  same reason, and because the score has to be definable from stored rows alone.
- **Content-addressed artifact discipline** (temp file, fsync, rename, 0600,
  verify before reuse, refuse the offload when the pointer is larger than the
  body). Deferred because this package keeps the bytes in the row on purpose;
  the item becomes live if externalization ever writes to disk.
- **One injection framing everywhere** and **a provenance suffix on recall
  hits**. Both are cheap, and both are cosmetic until a live case shows the
  model misreading recovered text as instructions or as current state.
- **Splitting the redactor into a pattern-only mask and an assignment mask**, so
  the diagnose bundle can mask every string in a metrics row rather than only the
  keys `FOREIGN_TEXT_FIELDS` names. Deferred because the allowlist is correct
  today: every writer of provider text uses `error`, which is on the list. The
  item becomes live the first time a metrics writer puts foreign text under a new
  key.

## Names

**Both packages are unscoped.** `pi-lossless` is the adapter and `lossless-core`
is the engine. A `@stainless-code/` scope arrives only on a real collision, and
then it arrives once, for every package at the same time. Both names are
unpublished and free; the unscoped `lossless` on npm is an unrelated published
package, which is what the harness prefix is for; and the docs app is already
scoped and private (`@stainless-code/lossless-docs`), so scoping stays a
decision available rather than one made by accident. What would force the scope
is a squat on any of the three names before the first release, or a cost that
the engine's adjacency to the unrelated `lossless` package inflicts on a consumer
once it publishes on its own.

**The core names no host SDK.** The port is `packages/core/src/host.ts`,
`packages/pi/**` is the only Pi-aware code, and a check over
`packages/core/src/**` fails on the first host import. What it does not claim:
no second consumer exists, so nothing in the boundary is validated by one.

## Rejected / already-superseded

- **better-sqlite3**: we stay on `node:sqlite` (zero native dependencies).
- **Per-message ingestion hooks** (`message_end`): the idempotent `turn_end`
  batch plus the `session_start` backfill covers the same ground with fewer hook
  invocations.
- **`session_fork` / `session_switch` events**: they do not exist in current Pi,
  so there is nothing to port.
- **Single-knob `smartZone` as a derivation of the token pair**: adopted as
  OR-mode vocabularies instead; no granularity was taken away.
- **A `@stainless-code/` scope for the harness packages before a collision**: the
  names are free, and the scope is a one-commit migration whenever it is wanted.
- **Renaming the packages to `lossless`**: the name is held by an unrelated
  published package.
