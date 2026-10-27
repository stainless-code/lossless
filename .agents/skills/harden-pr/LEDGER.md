# Harden ledger

Local working file. A fresh clone does not carry it; reads become no-ops there.

## Rejections

By-design drops from review passes. Findings matching an entry are dropped
without re-litigation.

- Exported-symbol JSDoc stays. Public-API docs on exported functions, types,
  and fields ship in dist typings and hovers; narration flags against them
  are rejected (2026-10-25 full-branch sicko pass).
- Host line-number pins and drift-rule comments stay. Each marks what mirrors
  the seam so a pin move has a checklist; the pin itself is the mechanism
  note (same pass).
- Plan-sketch code fences are documentation, not corpses. Fenced sketches in
  docs/deepseek-plan.md describe future shapes; flags against their `//`
  lines are rejected (same pass).
- MUST KILL reshapes are out of bounds. dshRef, UsageTracker,
  commitDagTransaction, DagStabilityError, resolveSummarizationTarget,
  MessageIndex, resolveEntryId, SpanAlreadyMemoryError, withSummaryRefs,
  cross-session caps, selectDagRange, lcmCommandDefinition, pressureZone,
  writeDumpTarget, whitespace sentinel, mechanicalToolNameOf split,
  SidecarStores opened handles, scopedGrepAll pushdown, toolScopeMessageIds
  scope state, liveStems, valueOf arg parsing, healInFlight guard,
  backfillSession accounting and visited budget: all need new shapes
  (redesigns), so their comments stay and the flags report open (same pass).
- UI routing comments stay. Sidebar and harness-nav comments record the
  reference-only constraint and cross-file sync points a reader cannot
  re-derive from the loop (same pass).
- Test-rationale comments stay when they state fixture, divergence, or
  expectation rationale; pure assertion echoes go (same pass).
- Negative metric limit reads all rows by design. `readMetricRows` treats a
  negative limit as unbounded and zero as empty, pinned by
  `util-metrics-sink.test.ts` (2026-10-25 gauntlet pass 1).
- Root README names the host ports and bundling once. Day-1 architecture
  needs the two-port contract and the inline-into-dist note; deeper internals
  stay out (same pass).
- Changesets describe behavior, not just the headline. This repo ships
  detailed per-package entries; the deepseek entry stays behavior-complete
  rather than trimmed to a headline (same pass).
- backfillSession Budget-type and visitedBudget-function MUST KILLs are
  rejected. The visited/consumed accounting is five explicit lines with the
  rule in one comment plus three regression tests; a Budget type would add
  indirection without removing a branch (2026-10-26 gauntlet).

## Deferred

- Recall scope closer (`toolScopeMessageIds` quoted-marker scan beyond
  toolResult opening lines), bare `tool <name>` matching, cross-session
  `offset`/`summary`/`include_removed`
  forwarding, ghost-session read-only open for minimal deps, dispose-then-close
  for live/healing stores: each
  needs a design decision (sharded past-search semantics, scope state machine,
  lifecycle close scheduling) beyond a polish pass. Recorded open, not fixed.
  Fixed from this row: `/lcm compact` error-code mapping tests (landed with
  the failure-code test), and the toolResult-row half of the scope scan
  (opening-line rule now matches `toolNameOfText`, pinned by regression test).
- Warm-scan probe cost: a warm remount re-probes every stored row (one indexed
  point lookup each) plus marker derivation, so per-mount work scales with
  history length while only writes and new evaluations are capped. Bounding the
  cheap probes too needs a persisted frontier (resume) design. Progress is
  guaranteed; the cost is accepted until a frontier design lands.
- Mount fan-out: one backfill per live session runs under one Promise.all.
  Live sessions per composition are inherently few, and serializing would slow
  the common single-session mount. A concurrency cap waits for a composition
  with enough live sessions to matter.
- Engine cold rescan: the first span miss re-derives the live log to rebuild
  the index. That is the documented cold-start path (fail-closed); changing it
  reshapes documented behavior.
- dag-commit point mapping: one indexed `messageByEntryId` read per shadowed
  seq. A range rewrite would change the per-seq fail-closed mapping into
  filter semantics; indexed point reads stand until a measured need appears.
- hydrateCheckpoint full load: cold ladder runs read all stored summaries to
  rebuild one checkpoint. Loading latest-plus-children instead reshapes the
  resume path; the one-time cold cost stands.
- Lossless preset forks: each `deepseek-lossless-web` preset is a full copy of
  the pinned harness preset with only the backend row swapped (2026-10-26
  harden pass). Generating them from a base-plus-diff or upstreaming a
  narrower preset-override hook would delete ~400 duplicated lines, but both
  need a design beyond polish (harness-owned composition shape).
- Host core registry: the module-level shared core with owner counting could
  move onto Cordis scoping once a host-provided service is the established
  pattern for cross-realm sharing. The current shape is explicit and tested;
  reshaping it would change mount/dispose semantics, so it waits for a design
  pass with a live web session behind it.
