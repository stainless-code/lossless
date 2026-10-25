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
