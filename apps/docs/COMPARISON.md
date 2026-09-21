# Comparison: pi-lossless against the Pi compaction engines

pi-lossless is Pi's adapter for a lossless context management engine: it
summarizes aged context into a DAG of summaries, keeps every original message
verbatim, and answers recall by address, so what compaction removed can be read
back. The extension inlines the engine (`lossless-core`), so an install stays
one package with no runtime dependencies. The engine is the memory half of the
LCM paper, and a second host adopts it by implementing two ports.

**Scope.** Pi packages only. The four engines below are Pi extensions, and they
are the packages a session actually chooses between. Other harnesses and their
context engines are out of scope: a session runs the engine its own harness
loads, so a cell measured elsewhere would not transfer to Pi.

Cells are read from code, never from a project's README. The four engines were
cloned and read against their source at the commits named in the verification
note.

Last verified: 2026-09-18.

That date covers the peer cells and the audits named in the verification note,
and this package's own cells, measured from this repository (`packages/core`
plus `packages/pi`).

## One matrix on the same axes

Legend: ✅ full · 🟡 partial · ❌ none.

| Dimension                          | pi-lossless                                                                                                                                          | pi-blackhole                                                                                                                                 | ds4-context-engine                                                                                                                     | pi-smart-compact                                                                                                         | pi-goosedump                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Returns a replacement compaction   | ✅ returns a compaction from `session_before_compact`; commit-batched, monotonic cuts                                                                | ✅ `{summary, details, tokensBefore, firstKeptEntryId}` from `session_before_compact`                                                        | ✅ `{summary, firstKeptEntryId, tokensBefore, usage, details}`                                                                         | ✅ `{summary, firstKeptEntryId, tokensBefore, details}`                                                                  | ✅ replaces Pi's by default (`overrideDefaultCompaction ?? true`), keeps Pi's cut point                                                               |
| Model-visible history after a pass | ✅ aged content becomes pointers; message roles never change                                                                                         | ✅ the `context` hook returns projected messages: per-segment summaries plus omission markers for kept tool outputs                          | ✅ the `context` hook replaces the message array in `managed` mode, which is the default                                               | ❌ no `context` hook at all; history changes only through the compaction payload and `ctx.compact()`                     | ✅ rewritten through a new compaction result, with no prefix guarantee                                                                                |
| Own store of the thread            | ✅ every message verbatim in SQLite + FTS5                                                                                                           | ❌ none; reads Pi's session JSONL                                                                                                            | ✅ own SQLite index, derived from the JSONL and rebuildable with `/context rebuild-index`                                              | ✅ own SQLite fact graph; `smart_recall` reads only that graph                                                           | 🟡 reads Pi's JSONL; memory keeps derived claims and head/tail-truncated evidence                                                                     |
| Verbatim original reachable        | ✅ any stored message by address, however many compactions ran                                                                                       | ✅ `recall` with `#N:text:full` returns the complete raw message body from Pi's JSONL                                                        | ❌ excerpt only, up to 6,000 chars with thinking, image and opaque blocks dropped                                                      | ❌ derived facts truncated to 800 chars; markdown backups are whole files reachable only through restore                 | 🟡 yes while Pi's JSONL holds the messages; memory returns claims, not the original                                                                   |
| Recall mechanism                   | FTS5 ranked search over all history including compacted-out content, bounded expansion by address, and an opt-in scan of past sessions' own stores   | in-memory BM25+ over session entries, 0.2 relative score floor; no index                                                                     | FTS5, literal `LIKE`, and optional vector RRF over exactly the entries Pi dropped                                                      | FTS5 `bm25` over a fact graph with one-hop edge expansion; no vectors                                                    | in-process FTS5 BM25 plus 384-d vector, entity expansion and typed-relation expansion under a token budget                                            |
| Recall tools                       | `lcm_grep`, `lcm_describe`, `lcm_expand_query`                                                                                                       | `recall`                                                                                                                                     | `context_persistence`, `context_artifact_search`                                                                                       | `smart_recall`, `smart_save_memory`, `smart_compact`                                                                     | `goose_remember`, `goose_recall`, `goose_forget`, `goose_memory_status`, `goose_search`, `goose_get`, `goose_grep`, `goose_compact`, `goose_sessions` |
| Summary quality control            | ✅ 3-level escalation with strict token-reduction acceptance; level 3 is a stored, tagged deterministic truncate; one make-smaller retry             | ✅ deterministic extraction by rule, no model call; an empty summary delegates to Pi's own summarizer                                        | ✅ LLM summaries validated against the source; a failed pass returns nothing and lets Pi compact                                       | ✅ a score-threshold gate over the generated summary, cost and yield budgets, and a true zero-LLM path                   | 🟡 2 attempts plus batch shrink; no escalation ladder                                                                                                 |
| Safety controls                    | ✅ ingest-time injection guard and XML fencing; redaction at every seam that hands stored text to a model, the store stays verbatim                  | ❌ no injection fencing and no secret redaction (ANSI and control chars only)                                                                | ✅ `[DS4 HISTORICAL EVIDENCE]` fencing; redaction only for remote destinations, and off by default                                     | ✅ labelled untrusted evidence with tag stripping; thirteen secret patterns plus optional PII, on by default             | 🟡 prompt-level instruction to treat the transcript as untrusted evidence, no scanner; secret handling absent                                         |
| Token budgeting and thresholds     | ✅ three vocabularies (ratios, absolute tokens, smartZone), per-model zones, safety clamp, budgets converted with a calibrated chars-per-token ratio | per-model piecewise curve over the window; immutable append segments spliced around untouched messages; no prompt-cache control              | per-model awareness config; cache-aware tail widening is opt-in and off by default, and the summarizer requests `cacheRetention: none` | minimum tokens measured against the model window; extraction cache keyed by prefix fingerprints; no prompt-cache control | 🟡 `summaryMaxTokens` 512 to 65,536 (default 4,096) clamped to 80% of Pi's reserve                                                                    |
| Runtime dependencies               | ✅ none shipped; `node:sqlite`, Node `>=22.19`; the inlined engine declares one npm dependency, `typebox`, which Pi supplies                         | none; model calls through pi-ai `streamSimple`; clipboard and `git` binaries                                                                 | none; `node:sqlite`; `git` binary                                                                                                      | none; `bun:sqlite` or `node:sqlite`; `git` binary                                                                        | ❌ a spawned native Rust binary per operation, plus first-use GGUF model download                                                                     |
| Operator surface                   | Cockpit, live gauge, cycle editing, backup / doctor / reset                                                                                          | `/blackhole` settings and cleanup, `/blackhole-memory`, `/blackhole-recall`, `/blackhole-export`; no doctor, and backup is a stale-file copy | `/context` with 27 subcommands, a status line, and a storage CLI with `inspect`, `compact` and `recover`                               | `/smart-compact` with `metrics`, `dashboard`, `restore`, `loops` and `settings`, an HTML report, and a damage monitor    | settings, search and sessions panels; 7 commands; no doctor or backup                                                                                 |

## What each one wins

Each of the four beats this package on some part of the problem.

**pi-lossless.** The combination of lossless verbatim recall with engine-side
provenance, cache-batched swap timing with runtime fresh-vs-cached measurement,
and smart-zone control (absolute-token thresholds plus per-model zones), on a
zero-native-dep SQLite index whose thresholds are converted with the model's own
calibrated chars-per-token ratio rather than a fixed four characters per token.

**pi-blackhole.** It owns Pi's compaction contract more completely, so
`/compact` and overflow use it too, and a provider outage still yields a
deterministic summary. Its segments are prefix-stable by construction.

**ds4-context-engine.** The closest design to this one: a summary DAG carrying
provenance edges, deterministic validation of exact values, sha256 artifact
offload for large tool output, plus a real prefix-cache policy.

**pi-smart-compact.** The only peer with an acceptance gate over the generated
summary and an explicit cost budget, plus a true zero-LLM path and secret
scrubbing on by default.

**pi-goosedump.** It runs fully offline with pinned local models, cites evidence
for every claim, and reads sessions from several coding agents.

None of the four stores the thread verbatim in an index of its own, which is
the cell this package exists to fill.

## Where the field is ahead of this package

A peer audit named ten mechanisms this package did not have. Nine of them ship
now. The row below is what remains open: a mechanism a peer ships, verified in
its source, that this package does not have.

| Mechanism                                           | Peer, and where it is               | Why it matters here                                                         |
| --------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Deterministic validation repair before falling back | ds4-context-engine's bullet pruning | Dropping the one invented figure is cheaper than discarding a whole summary |

The forward work with paper citations and evidence gates is in
[the roadmap](https://github.com/stainless-code/lossless/blob/main/docs/roadmap.md#open-work).

## By design, not missing

Honest gaps against this field, each with the reason it stays that way:

- **No semantic or vector recall.** The store is FTS5 plus exact addressing.
  Peers with embeddings answer "something like this" queries we cannot. A
  verbatim address plus ranked full-text search covers the recovery case, and a
  vector index would add an embedding dependency to an engine whose only npm
  dependency is `typebox`.
- **No curated memory tier.** There is no `MEMORY.md` the user edits, no forget
  and restore primitive over stored memory, and no per-project memory identity.
  The peers' product is curated memory a human can audit. This package keeps
  the thread.
- **No secret ever blocks a write.** The row stays verbatim and the secret is
  masked at every seam that hands stored text to a model. Peers that block the
  write outright reject a memory that contains a key, and peers that redact
  before the store keep different bytes than the session produced. Masking on
  the way out keeps both the memory and the recoverable original.
- **No local model inference and no external service.** Every model call in the
  summarizer path goes through the session's own provider. Peers that run
  pinned GGUF models offline do something we do not.
- **No benchmark campaign yet.** pi-fold publishes reproduced benchmark results;
  our measurement story is in-session `metrics.jsonl` telemetry. The
  deterministic-briefs question is queued behind our own validation protocol.
- **No folding of in-place context.** Aged head content becomes pointers, and
  the message roles stay untouched.

Where this package departs from the paper, each deviation with its reason, is
in
[the roadmap](https://github.com/stainless-code/lossless/blob/main/docs/roadmap.md#paper-conformance).

## When to pick which

| You want                                                                                       | Reach for                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| Searchable, verbatim-recoverable history with provenance from summary to source, on current Pi | **pi-lossless** (`npm:pi-lossless`) |
| Facts and preferences that outlive the session, in files you can read and edit                 | pi-memory, pi-hermes-memory         |
| Semantic recall across sessions and machines, accepting an LLM or a hosted service             | @amaster.ai/pi-memory-mem0          |
| Search over old sessions plus offline local summarization, and you accept a native binary      | pi-goosedump                        |
| Deterministic folding with minimal LLM spend and published benchmarks                          | pi-fold (`npm:pi-fold`)             |

## Do not run two engines in one session

Every engine compared above takes over the same decision: it returns a
replacement compaction from `session_before_compact`, calls `ctx.compact()`
with its own instructions, or rewrites history through its own compaction
result. Running two means two engines cutting the same window, and the model
sees whichever result lands last. Threshold-only packages and display packages
do not take over that decision and can sit alongside an engine, though a cap or
a trigger changes when the engine fires.

Cross-session memory packages (pi-memory, mem0-style stores,
pi-hermes-memory) are additive and can coexist with an engine: they append
prompt text or a recall message rather than replacing a compaction. The cost
is token pressure from two injection layers, and each one has its own idea of
what deserves to be in the window.

## Verification note

Method and coverage:

- The four engines were cloned locally and read against their source at these
  commits: pi-blackhole `51e4cfe` (2026-09-15, v0.5.5), ds4-context-engine
  `40eaeda` (2026-09-08, v0.3.9), pi-smart-compact `687f72c` (2026-09-05,
  v9.6.2, a squashed clone with no deeper history) and pi-goosedump `fb1c27f`
  (2026-09-13, v0.12.64, including the Rust engine and the API wrapper in the
  same monorepo). Every claim in the matrix above was read from code, and the
  load-bearing cells (hook sets, compaction behavior, storage, safety controls)
  were re-checked by hand against the clones after the audit.
- Two early cells were wrong before the line audits and are corrected above:
  pi-blackhole keeps no database and no vectors, and ds4-context-engine does
  register recall tools.
- Versions, publish dates and dependency facts come from npm registry
  metadata; where the repo and the published package disagree, the note says
  so.
- This package's own rows are measured from this repository. The engine's
  manifest declares one npm dependency, `typebox`; the adapter inlines the
  engine into its bundle and leaves only its peers external
  (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui` and `typebox`), so the published adapter's runtime
  dependency list stays empty.
- This field moves fast. Re-verify before treating any cell as everlasting.
