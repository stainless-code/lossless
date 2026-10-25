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
  scope state: all need new shapes (redesigns), so
  their comments stay and the flags report open (same pass).
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

## Deferred

- Recall scope closer (`toolScopeMessageIds` quoted-marker scan),
  bare `tool <name>` matching, cross-session `offset`/`summary`/`include_removed`
  forwarding, ghost-session read-only open for minimal deps, dispose-then-close
  for live/healing stores, and `/lcm compact` error-code mapping tests: each
  needs a design decision (sharded past-search semantics, scope state machine,
  lifecycle close scheduling) beyond a polish pass. Recorded open, not fixed.
