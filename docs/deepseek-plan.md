# DeepSeek plan

Status: active spike. The code lives on `feat/deepseek`, extracted from
`spike/second-consumer`. OpenCode v2 already shipped alongside Pi; this plan
tracks the DeepSeek adapter. Roadmap item 10 describes the live-proof gate.

Goal: answer whether `lossless-core` can serve the DeepSeek harness as one
more adapter, without weakening the engine boundary or the Pi adapter.

## Constraints the design must honor

These come from the tree, not from preference.

- The engine boundary holds. `packages/core/src/host.ts` is the only host
  surface (`ModelHost` plus `Reader`), and the boundary check fails any module
  under `packages/core/src/` that imports a host SDK. Another adapter proves
  the boundary instead of widening it.
- The target harness owns surface mutation. Its session is an append-only log,
  `deriveMessages()` renders the model history, and loop-built requests arrive
  frozen. There is no equivalent of the Pi `context` event that rewrites the
  outgoing request in flight. Model-visible change must be a logged event, normally
  a `user/message` with a `replace` operation inside the `compaction/start` to
  `compaction/end` bracket.
- The target's compaction seam is `compactIfNeeded`, `compactNow`, and
  `compactRegion` on one `CompactionEngine` per composition, with tool-pairing
  balance checks on both edges and a shrink check that rejects a summary no
  smaller than its span.
- Lossless behavior worth keeping: verbatim ingest, the leaf plus condensed DAG
  with escalation to a deterministic floor, addressable summary ids, a budgeted
  reader loop over `lcm_grep`, `lcm_describe`, and `lcm_expand`, per-model
  calibration, and the metrics rows that make a pass auditable.
- Names stay unscoped until a collision forces the one-commit migration that
  `docs/roadmap.md` already describes. The working name below is a placeholder
  the owner replaces.
- No comparison claims ship with this work. `apps/docs/COMPARISON.md` stays
  Pi-only per roadmap item 10.

## Candidates considered

Three shapes, structurally distinct.

### A. Recall-only sidecar

Keep the shipped basic compactor. Add a plugin that mirrors session history
into a sidecar store and registers the three recall tools plus one command.

```yaml
- name: basic-compaction-backend
- name: lossless-recall
```

Smallest diff. It proves ingest mapping, the `ModelHost` mapping over
streaming calls, and tool registration. It concedes compaction policy entirely,
so the DAG, the swap timing, and the pointer projection buy nothing yet.

### B. Summarizer subclass

Subclass the shipped `BasicCompactionEngine` and override only `summarize()`.
Route that hook through lossless escalation and the sidecar store. Keep the
target's transaction, meter, retention, and lock behavior untouched.

```ts
class LosslessSummarizerEngine extends BasicCompactionEngine {
  protected summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // not implemented: build the lossless prompt from input.messages,
    // call through the host port, frame the checkpoint
  }
}
```

Medium diff. It changes summary quality without owning range selection or
surface writes. It still concedes the DAG shape, because the seam expects one
checkpoint per transaction, not a frontier of nodes.

### C. Full engine backend

Implement `CompactionEngine` directly. Map lossless retention onto region
selection, lossless `runCompaction` onto the bracket transaction, and the
frontier onto the replacement checkpoint.

Largest diff and largest risk. It must reimplement lock handling, stability
checks for whole-surface versus selected-span calls, and the busy taxonomy
correctly. It is the only shape that carries the full lossless policy across.

## Synthesis decision

Order the work A, then B, then C only on evidence. Each phase is usable on its
own, and each is the prerequisite of the next. This follows Foundational
thinking (scaffold before features) and Sequence verifiable units (one checkable
state per phase).

## Candidate C plan (DAG parity slices)

Verified against the published tarball at the pinned release: the package
root exposes config types and `BasicCompactionEngine` only. No region
internals, no range selection, and not even the `summarize()` contract cross
the published boundary. So any C built on published code stays inside the
subclass seam, and the risky machinery stays the target's without any
reimplementation: the lock is a durable unmatched `compaction/start` marker
read from the log, and stability checks, the busy taxonomy, the shrink check,
and the commit framing all run behind `super.compactRegion`. The earlier
warning that C must reimplement them applied only to a C that bypasses the
engine; that C is not planned.

The DAG already runs in the sidecar under B: `runCompaction` stores leaf and
condensed nodes with coverage, proven by the engine tests. The remaining gap
to voltropy parity is three slices, each independently testable:

- C1, checkpoint pointers. The ladder outcome already returns leaf and
  condensed summary ids. Include `[lcm:summary #N]` refs in the checkpoint
  text so the model and the recall tools can cite and resolve DAG nodes.
  Evidence: a real compaction whose derived checkpoint names ids that
  resolve in the sidecar.
- C2, previous summary. Feed the prior checkpoint as `previousSummary` so
  the ladder merges instead of re-summarizing. The plugin tracks the last
  checkpoint text per session (projection state), which avoids parsing
  checkpoint tags. Evidence: a second compaction over checkpointed history
  whose ladder input carries the previous summary.
- C3, already-memory mapping. Map a ladder `nothing` outcome (span rows all
  covered) to a graceful `null` instead of a failed compaction. The planned
  coverage-aware narrowing was dropped after analysis: replace semantics keep
  the surface head always uncovered, so a covered prefix cannot occur, and
  covered-but-live rows (range expansion catching retained rows older than a
  checkpoint) stay truly covered under shadowing, so compacting over them is
  already correct. Evidence: forcibly compacting an already-covered live span
  rejects with `SpanAlreadyMemoryError` instead of the seam's generic
  could-not-summarize failure. Null is not the answer there: the forcible
  seam always compacts or throws by contract, and the auto path never selects
  a fully covered span because replace semantics keep the head uncovered.

Seam constraint, accepted: one checkpoint per transaction. The DAG lives in
the sidecar and the checkpoint is its projection, which is sufficient for
recall because the reader resolves pointers. Optional later upstream ask: a
small PR exporting the region functions and the summarize contract from the
package root, which removes the structural-copy drift rule. Not blocking.

## Custom transaction flow (DAG-wins assumption, design sketch)

The C slices are done, so this section designs what the confirmed
assumption commits us to: the DAG itself living in the DeepSeek log
instead of projected from the sidecar into one checkpoint per
transaction. If the item 1 numbers, once runnable, show the DAG does not
beat structured checkpoints, this flow was unnecessary and candidate B
stays the ceiling.

### Problem: what a transaction is, and what constrains a custom one

Traced from the pinned `dsh-compaction-basic` lib. Config types and
`BasicCompactionEngine` are the whole published boundary.

- One transaction is `compaction/start`, then `compaction/summary` (a log
  record with shadowed range, seqs, token count, provider, model, usage)
  plus `user/message` with a `replace` surface op, then
  `compaction/end`. Failure still appends `compaction/end` carrying the
  error, which is what releases the durable lock (an unmatched
  `compaction/start` read from the log).
- The shrink check rejects a framed checkpoint at or above the shadowed
  route token count. Near-verbatim leaf nodes cannot pass it as replaces.
- Stability is span-scoped or whole-surface; the busy taxonomy separates
  manual-idle (`owner: null`, no open turn) from auto (open turn
  required).
- Checkpoint framing (preamble, `<compacted-summary>` tags,
  `compactCheckpointSource`) is reader and tooling surface: custom commits
  must reuse it byte for byte.
- No live-model verification exists on this branch: every slice proves
  itself through scripted adapters only. The live-proof Evidence bullet below
  covers the adapter loop on a live session; the transaction-flow numbers
  (item 1) still wait on a DeepSeek key.

### Candidate A: orchestrated multi-compact through the published seam

Run the ladder once, then commit one DAG node per `super.compactRegion`
call, staging each node text for the per-transaction `summarize()` hook.
No reimplementation, no upstream PR, every bracket independently valid to
their tooling.

It fails on the shrink check: leaf text is near-verbatim, so leaf replaces
are rejected, and the seam always pairs a summary record with a replace.
Through the published seam only condensed nodes can be committed, which is
a chain the C2 carryover already yields across compactions, not a DAG in
the log. A is status quo with orchestration, not parity.

### Candidate B: one bracket, custom commit body

Reimplement the bracket in the adapter: open, run the ladder once outside
the seam, commit one condensed replace plus one log-only
`compaction/summary` record per leaf (no surface op, linked by
`sourceEventSeqs`), close. The DAG lives in the log while the surface
pays only for the condensed node.

Caller usage first:

```ts
// Implements this shape, with one amendment recorded below
const result = await commitDagTransaction(deps, agent, selection, {
  owner: null, // or a non-null marker for the auto path
  stability: "whole-surface", // or "selected-span"
  signal,
});
// result: { compactionId, startSeq, summarySeqs, leafSeqs, endSeq }
```

Types derived from it: `DagCommitResult` as above (no `DagNodeCommit`:
the ladder runs inside the bracket, see the amendment). Module map: a new
`packages/deepseek/src/dag-commit.ts` holds the bracket; `engine.ts` gives
up a `runLadder(ctx, lossless, target, sessionId, span, signal)` helper
that `summarize()` keeps using for the B path, so the ladder runs
identically inside and outside the seam. Framing, lock check, stability
predicate, the shrink check on the condensed replace, and the manual/auto
error taxonomy are reimplemented against the pinned lib line for line,
each marked with the source line it mirrors so a pin move has a checklist.

Amendment (B1): the sketch passed precomputed `nodes` in. The bracket
owns the ladder instead, mirroring how `compactSurfaceRegion` owns its
summarizer. Passing nodes in would split open/commit across the caller
boundary and leave ladder errors outside the failure taxonomy, which is
the half the spike exists to prove. Two deliberate divergences from the
lib, both marked B1 in code: single ladder attempt (no recover retry
loop; arrives with production wiring) and one log-only summary record
per stored DAG node, appended before the condensed record so the seam's
shadow-price adjacency contract still holds.

### Synthesis decision

B is the only shape that puts the DAG in the log; A cannot carry leaves
through the seam. Build B in slices: B0 this sketch, B1 bracket spike
against scripted models (open, commit, close, plus the failure path
releasing the lock), B2 production wiring through the plugin paths, with
convergence onto exported region primitives as a later option if the
upstream PR ever lands. Each slice re-verifies the B path has not
regressed, because the custom flow and the subclass seam now share the
ladder helper.

B1 landed: `packages/deepseek/src/dag-commit.ts` (`commitDagTransaction`),
`packages/deepseek/test/dag-commit.test.ts` (3 tests: condensed replace
plus leaf records in one bracket, ladder failure closes with error and
releases the lock, manual taxonomy on idle), and the `runLadder` /
`resolveSummarizationTarget` / `withSummaryRefs` extraction in
`engine.ts` that `summarize()` keeps using. Gates green: `vp check`, 584
tests, typecheck, pack.

B2 landed (manual production path through the bracket):

- `packages/deepseek/src/ladder.ts` holds the shared ladder
  (`LosslessEngineDeps`, `runLadder`, `resolveSummarizationTarget`,
  `withSummaryRefs`, `SpanAlreadyMemoryError`, `checkpointMemory`);
  `engine.ts` re-exports the pre-split names so no consumer changed.
  The split keeps the module graph acyclic (engine references the
  bracket, the bracket references the ladder).
- `DagCommitResult` is a superset of the seam's `CompactionResult`
  (branded ids plus `summarySeqs`/`leafSeqs`), so the engine override
  and `/lcm compact` read it unchanged.
- `selectDagRange` mirrors `selectCompactableRange`; the engine
  `compactNow` override mirrors the seam's idle admission, selection,
  and flush, with the bracket as the transaction.
- Auto pressure (`compactRegion`) stays on the B seam, so the B-path
  regression suite keeps pinning it. Routing auto through the bracket
  waits until the manual path has proven itself live.

B3 landed (flag-gated auto routing): `bracketAuto` on `LosslessEngineDeps`
and `LosslessPluginConfig` routes `compactRegion` through the bracket
(owner current-turn, whole-surface stability) while the default stays the
seam. The flag rides our own deps because the seam's `resolveConfig`
rejects unknown keys, so it cannot travel on `BasicCompactionConfig`.
Tests pin the bracket commit on an open turn and the raw (unwrapped)
ladder failure on the auto path. Gates green: `vp check`, 594 tests,
typecheck, pack.

- Tests: `selectDagRange` (null, range shape, drift fails closed),
  `compactNow` (bracket commit, null, busy on open turn, busy on
  refused maintenance, cancelled), and the `/lcm compact` production
  test now pins the DAG shape (condensed plus leaf records under one
  id). Gates green: `vp check`, 592 tests, typecheck, pack.

## Comparison docs direction (staged, waits on live proof)

- The shipped docs keep per-harness reference pages (`pi`, `opencode`,
  and `deepseek` when it ships): host-specific facts only. A root page
  with shared guarantees stays a staged idea until the adapter proves
  itself live; nothing is ever copied between pages.
- The docs-governance skill gains a lane for the root-plus-pages structure
  only if the root page happens.
- Package READMEs stay as they are. Only the docs site changes.

## Quality bar for this workstream

Every slice ships production grade: clean, efficient, performant, composable,
and extensible, with keep-it-stupid-simple winning wherever it does not cost
one of the others. Concretely: no new machinery where the seam already owns
it, no speculative abstraction, no dead config, per-session state instead of
globals, fail-closed errors the engine's recovery path already handles, and
green gates (`vp check`, `tsc`, `bun run test`, `bun run pack`) before every
commit.

## Module map

One new package holds every host-aware line. Core stays host-free.

```text
packages/deepseek/
  src/
    index.ts       plugin entry: engine registration, tools, command
    model-host.ts  ModelHost over the streaming call API
    reader.ts      Reader over the recall tools
    ingest.ts      log observation mapped to ingestible entries
    tools.ts       recall tool definitions
    engine.ts      summarizer subclass over the lossless ladder
    ladder.ts      shared ladder the seam and bracket paths both run
    dag-commit.ts  bracket transaction around one condensed replace
    command.ts     operator command and config verbs
    lifecycle.ts   read-only and dry-run verbs behind the command
    metrics.ts     JSONL rows beside the sidecar
    plugin.ts      composition wiring behind the enabled flag
```

The caller configures it the way the target composes everything else, by
selecting the capability in configuration:

```yaml
- name: lossless-recall
- name: lossless-compaction
  config:
    keepRecentTokens: 20000
    summaryTokens: 1500
```

## Phases and evidence gates

Run `vp check` after every phase. Add `bun run test` and `bun run typecheck`
for any phase that touches `packages/*/src/**`.

1. Port proof in a scratch composition. Implement the host port over one
   streaming call and run one summary plus one retrieval against the
   mechanical path. Evidence: the test log showing text assembled from chunks
   and mapped to the `ModelAnswer` union, including the capped case.
2. Ingest mirror. Observe the live log and the persisted copy, write both to
   a throwaway store, and compare entry counts against the derived message
   count. Evidence: counts match across a session that includes tool calls,
   a steering injection, and a resume.
3. Recall tools. Register the three tools in agent scope, ask a question whose
   answer lives only in aged history, and require the answer to cite an entry
   id or a summary id. Evidence: cited answer plus the retrieval budget rows.
4. Engine hook behind a flag. Ship candidate A or B with the engine disabled
   by default, then enable it on one composition and replay a compacted
   session deterministically. Evidence: identical derived messages on replay
   and the target's own compaction tests still green.
5. Policy, command, and config. Wire thresholds, per-model overrides, the
   operator command, and the metrics rows. Evidence: a pressure run that swaps
   before the window fills and a quiet run that leaves the log untouched.

Stop after any phase whose evidence fails. A failed phase is a finding for
roadmap item 10, not a reason to start the next phase.

## Owner decisions (recorded)

- Package name: `deepseek-lossless`, in `packages/deepseek/` to mirror the
  `packages/pi` holding `pi-lossless` convention (internal only; the shipped
  name is what matters).
- Comparison docs: restructure toward a root page with per-package sub-pages
  (see below). Implementation waits on live proof, per roadmap item 10.
- Candidate C: proceeded as DAG-parity work in slices (done: C1 refs, C2
  carryover, C3 already-memory). The item 1 measurement is blocked (no
  DeepSeek account, so no live-model DeepSeek arm); the work continues on
  the confirmed DAG-wins assumption, with the numbers as a stop/confirm
  gate when a key exists. Roadmap item 10 tracks this work until then.
- Parity program (slices 1-6 done on `feat/deepseek`, scripted models only):
  answered retrieval, metrics rows, full `/lcm` verb set, recall param
  parity with cross-session reads, seam knob and budget forwarding, async
  backfill. Suite stands at 79 package tests green with gates clean.
- `enabled` default stays opt-in (`enabled !== true` returns noop).
  OpenCode defaults true; flipping here changes mount behavior for every
  existing composition, so it waits on an explicit owner call. Recorded as
  a known divergence, not an oversight.
- `bracketAuto` default stays off until the bracket manual path proves
  itself live. The B-path regression suite pins the seam default.
- Blocked pending harness seams (verified in harness source, not assumed):
  settings cockpit overlay (no custom-render seam on the composition ctx),
  Pi-style projection policy (auto pressure belongs to the seam engine),
  synchronous pre-mount scan (prohibited; async observation is the
  permitted path and is now the backfill), provider window auto-correction
  (no named-window error seam; `tokenMeter.measure` covers steady state).

## Evidence (spike branch `spike/second-consumer`)

Target checkout `38286a6cf9` (release `dsh-0.1.7-alpha.2`, vendor `4.0.4`).
Pins match exactly: `dsh-*@0.1.7-alpha.2`, `cordis@4.0.4`.
Current pins: `dsh-*@0.2.1-rc.3`, `cordis@4.0.5`, against harness HEAD `22ddee3792`.

- Target baseline: `pnpm vitest run packages/compaction` in the checkout,
  13 files and 263 tests green.
- Lossless suite with the new package: 578 tests green (`vp check`, `tsc`,
  `bun run test`, `bun run pack` all pass; the package packs to 26KB with
  the harness left external).
- Phase 1: scripted adapter through the real escalation ladder and one
  `runRetrieval` in two steps against a real store.
- Phase 2: every derived text block lands in the sidecar, re-mirroring
  inserts nothing, and a replace checkpoint shrinks derived history while
  shadowed entries stay stored.
- Phase 3: three tools registered on a real tools composition; answers read
  from a real store.
- Phase 4: one real `compactRegion` through the ladder with leaves in the
  sidecar and the envelope on the summary event; fail-closed on unmapped
  history; the engine shrink check fires on an irreducible span.
- Phase 5: disabled-by-default plugin; live-feed mirror with `/lcm status`;
  one full manual compaction through the `/lcm compact` handler; one quiet
  pressure run returning null with the log untouched.
- C1: the derived checkpoint names `[lcm:summary #N]` refs that all resolve
  in the sidecar.
- C2: a second compaction over checkpointed history produces a checkpoint
  starting with the first checkpoint's exact text, through the live feed
  across two manual compactions.
- C3: spans order by sidecar rowid (core reads a span as a storage range);
  forcibly compacting an already-covered live span rejects with
  `SpanAlreadyMemoryError` while the surface stays untouched.
- Suite with the C slices: 581 tests green.
- B1: `commitDagTransaction` commits one condensed replace plus log-only
  leaf records in one bracket; ladder failure closes with error and
  releases the lock; manual taxonomy on idle. `runLadder` is shared with
  the seam `summarize()` so the summarizer cannot drift.
- B2: the production manual path runs the bracket (`compactNow` override
  mirrors idle admission, selection, flush); `DagCommitResult` stays a
  superset of the seam result so `/lcm compact` reads it unchanged; the
  `/lcm compact` test pins the production DAG shape.
- B3: flag-gated auto routing (`bracketAuto`, default off) through the
  bracket; the flag rides our own deps because the seam's `resolveConfig`
  rejects unknown keys.
- Suite with the B slices: 594 tests green (`vp check` clean, `tsc`,
  `bun run test`, `bun run pack`).
- Memory hydration: `checkpointMemory` takes a sidecar lookup and rebuilds
  the last checkpoint from the newest stored summary plus its children
  when the process has no noted text, so a resumed session compacts with
  continuity. Exact for leaf-plus-condensed runs; a single-leaf run
  replaces its row's text on condensation, so the rebuild carries the
  stored form. Suite: 596 tests green.
- Finding for a future pin move: the package root omits the `summarize()`
  contract members, so the override repeats their shape (drift rule in
  `packages/deepseek/src/engine.ts`).
- Parity slice 1: `lcm_expand_query` answers from aged history through the
  in-process reader and cites the entry or summary id, with one
  retrieval-kind row per run and no cross-session search yet. Suite: 41
  tests green (`vp check`, `tsc`, `bun run test`).
- Parity slice 2: the DeepSeek adapter writes metrics rows beside the sidecar
  (new `packages/deepseek/src/metrics.ts` with the OpenCode rotation policy
  and 0600 modes): one `pass`-kind row per ladder run with the outcome plus
  leaf and condensed counts and tracker usage, one `compaction-checkpoint`-kind
  row per DAG bracket commit with condensed plus leaf seqs, and `recall` plus
  `retrieval` rows through the wired recorder. Suite: 44 tests green
  (`vp check`, `tsc`, `bun run test`, `bun run pack`).
- Parity slice 3a: `/lcm` grows `status|report|backup|export|diagnose` beside
  `compact` (new `packages/deepseek/src/lifecycle.ts`, mirroring opencode;
  single registration with manual subcommand dispatch, since the registry
  rejects a duplicate `lcm` name). Status keeps the counts lines and adds the
  meter window with thresholds plus the last pass outcome; report rolls up the
  slice-2 rows in the OpenCode vocabulary; backup and export write 0600 files;
  diagnose builds the redacted core bundle with `--save` support. Suite: 50
  tests green (`vp check`, `tsc`, `bun run test packages/deepseek`,
  `bun run pack`).
- Parity slice 3b: `/lcm` grows `import|gc|migrate|heal`; gc/migrate/heal
  dry-run by default with `--apply` the only destructive path, and import
  runs on its named file (new verbs in
  `packages/deepseek/src/lifecycle.ts`, dispatched in `command.ts`, `storeFor`
  wired in `plugin.ts`). Import dedups through `importTranscript`; gc collects
  age-based sidecar candidates and never touches live stems; migrate gates on
  `storeGeneration` against `SCHEMA_VERSION`; heal runs core `runHeal` with
  core default budgets until slice 5 calibrates this adapter. Suite: 54
  tests green (`vp check`, `tsc`, `bun run test packages/deepseek`,
  `bun run pack`).
- Parity slice 4: `lcm_grep` reaches Pi param parity (`pattern`,
  `case_sensitive`, `offset`, `after`, `summary_id`, `include_removed`,
  `scope`) over core `grepView`, `lcm_expand` gains `session`, and
  cross-session search plus reads run through the sidecar listing with Pi
  caps (20 stores, 40 hits, 1.5 s) and `sessionsScanned` recorded; the
  default scope stays the current session. Suite: 63 tests green
  (`vp check`, `tsc`, `bun run test packages/deepseek`).
- Parity slice 5: seam policy knobs (`thresholdRatio`, `retainTokens` /
  `retainRatio`, `headroomTokens`, `modelPolicies`) ride the plugin config
  into the resolved seam config with adapter-only keys kept off it;
  summarizer caps thread into the ladder `makeLlm` config and the heal
  `makeLlm` plus `runHeal` budgets, with an unset heal source deriving
  8 x target clamped 3000..24000 inside core `runHeal`; `reasoning` stays
  false per the harness sources. Suite: 72 tests green (`vp check`, `tsc`,
  `bun run test packages/deepseek`, `bun run pack`).
- Parity slice 6: pre-mount history backfills through the async observation
  seam (the same `observeSession` call the host history controller pages
  from in `packages/api/session-controller/src/history.ts`), paged at 50
  events with a 500-event per-session cap and mirrored through the live
  `mirrorEvent` path, so re-mirroring inserts nothing; each backfill writes
  one `backfill` metrics row with its ingested count and span. Suite: 79
  tests green (`vp check`, `tsc`, `bun run test packages/deepseek`,
  `bun run pack`).
- Live proof 2026-10-25 (installed dsh 0.2.1-rc.3, throwaway `lossless-proof`
  profile, wrapper outside the repos, agent on OpenCode Go
  `deepseek-v4.1-flash`): auto pressure fired on a live session; the seam
  path stored 6 leaves plus 1 condensed node with a checkpoint replace on
  the surface and one `pass` metrics row. Summarizer routed to OpenRouter
  `deepseek/deepseek-v4.1-flash-1017` wrote real prose leaves plus a
  condensed parent (usage billed); the Go route 400s direct summarizer calls
  (`MissingSessionID`: no `x-opencode-session` header), which escalation
  absorbed into mechanical nodes. A fresh session called `lcm_grep` plus
  `lcm_expand` and answered verbatim with cross-session entry citations.
  A defaults quiet run mirrored 7 rows with 0 summaries. Two boot bugs fixed
  with TDD on the branch (uninjectable `sessionQuery` degrades to
  live-mirror-only; cold message map re-derives from the live log). Suite:
  873 tests green. Merge and item 10 stay owner decisions.
- Live proof, continued: the Go `MissingSessionID` 400s are fixed on our end
  by stamping the calling session id into `GenerateOptions` (the port field
  pi-ai maps to the header; agent calls always had it, ours never sent it).
  Depth-2 DAG formed live (61 summaries: 47 leaves, 14 condensed, max depth
  2, over 4 swaps with billed usage). Caveat as tuning follow-up, not a loop
  defect: Flash via Go is pathologically verbose on rung prompts (60k
  output-cap hits on 2-3k-token sources), so those nodes fell back
  mechanical, while OpenRouter Flash wrote clean prose on the same prompts.

## Open questions for the owner

- Whether the single-prompt `complete()` shape is acceptable when the target
  reuses provider prefix cache only for verbatim replays of system prompt,
  tools, and messages.
- Whether the sidecar store stays a file beside the session or moves onto the
  target storage backend later.
- The package name, the config key spellings, and the compat pins against a
  harness that warns of breaking changes.
- Whether item 10 ever advances past tracking, and whether the extracted
  branch merges to main. The item 1 evaluation stays unrunnable until a
  DeepSeek key exists; its numbers are a stop/confirm gate on the
  transaction flow, not a precondition.

## What this plan does not change

No source, no config, and no version beyond what `feat/deepseek` already
carries. No changeset, because nothing ships. No edit to the docs site or
any package README beyond this file. The B1-B3 bracket spike was proven on
scripted models; roadmap item 10 stays a tracking item, so no spike log
attaches to it beyond this plan.

Spike verdict: the custom transaction flow is proven on scripted models
across all three production paths (seam auto, bracket manual, bracket auto
behind a flag), with the B path's regression suite pinning the default.
What scripted models cannot prove is live-harness behavior (real pressure
timing, real flush backends, real prefix-cache effects), so merging the
spike to main and reopening item 10 stay owner decisions. The recommended
next work is roadmap item 1, the long-context evaluation: it is the only
source of measured evidence for the rest of the list, and its numbers are
the stop/confirm gate on this transaction flow.
