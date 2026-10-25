---
name: deepseek-lossless
description: "Use when a DeepSeek session has deepseek-lossless applied: search compacted history with lcm_grep, lcm_describe, lcm_expand, or lcm_expand_query; run /lcm status, report, backup, export, import, gc, migrate, heal, diagnose, or compact; or tune the compaction thresholds."
license: MIT
metadata:
  type: composition
  library: "deepseek-lossless"
  library_version: "0.1.0"
requires: []
sources:
  - stainless-code/lossless:packages/deepseek/src
---

# deepseek-lossless

`applyLossless` composes lossless memory into a harness context: every session
mirrors into its own SQLite sidecar, the summarizer engine mounts as the
compaction backend, and the composition registers four recall tools plus `/lcm`.
Nothing registers, mirrors, or mounts until `enabled` is true. Past the
pressure point the engine compacts automatically when `auto` is on; `/lcm
compact` compacts on demand.

## Install

```ts
import { applyLossless } from "deepseek-lossless";

const stop = applyLossless(ctx, { enabled: true });
```

Enable on one composition at a time; the returned disposer stops the mirror,
the tools, and the command.

## Commands

- `/lcm status`: session counts plus the meter window and last pass outcome.
- `/lcm report`: this session's metrics rows.
- `/lcm backup [file]`: copy this session's sidecar (mode 0600).
- `/lcm export [file]`: write the verbatim transcript and summaries as JSONL (mode 0600).
- `/lcm import <file>`: restore rows from an export.
- `/lcm gc [--apply]`: dry-run age-based sidecar collection; `--apply` deletes.
- `/lcm migrate [--apply]`: dry-run the older-schema list; `--apply` migrates.
- `/lcm heal [--apply] [--max-nodes N]`: dry-run the truncated list; `--apply` spends model calls.
- `/lcm diagnose [--save <file>]`: redacted, pasteable diagnostics bundle.
- `/lcm compact`: one manual compaction on demand.

## Recall tools

- `lcm_grep`: full-text search over this session. `query` is FTS5 (words, quoted phrases, `AND`/`OR`, prefixes); `pattern` is a JavaScript regex over the full text of every message, case-insensitive unless `case_sensitive` is set. `scope: "sessions"` or `"all_sessions"` searches past sessions in the same sidecar directory; the two are equivalent because the directory is global. Caps: 20 stores, 40 hits, 10 per store, 1.5s deadline.
- `lcm_describe`: inspect one summary (kind, depth, costs, children, parents, full text) without expanding it.
- `lcm_expand`: read the verbatim originals a summary covers, or one entry by `entry_id`. `session` reads a past session's sidecar read-only; the text is labelled as a past session's history.
- `lcm_expand_query`: a bounded reader expands the stored originals and returns findings only, so the raw transcript never enters the context. Ask for verbatim quotes in `prompt` when the exact words matter.

## Config essentials

```json
{ "enabled": true, "sidecarDir": "./.lossless", "auto": false }
```

- `sidecarDir` holds one SQLite file per session; delete one to forget that session.
- `auto: false` (default) runs no automatic pressure compaction; `/lcm compact` works regardless. `bracketAuto: true` routes automatic compaction through the DAG bracket.
- `summarizationProvider` / `summarizationModel` unset follow the routed model.
- `thresholdRatio` (default `0.8`) sets the window fraction where pressure compacts; `retainRatio` (default `0.16`) keeps that fraction of recent context verbatim. `retainTokens` replaces the fraction with an absolute budget; the two are mutually exclusive.
- Budgets: `summarizerTokensPerCall`, `summarizerTokensPerPass`, `summarizerTokensPerHeal`; `healSourceTokens` unset derives 8x `summaryTokens`, clamped to 3000 through 24000.

## Common mistakes

- **Expecting anything with `enabled` unset.** The master flag defaults off, so no mirror, no tools, and no command exist until one composition sets it true.
- **Expecting automatic compaction by default.** `auto` defaults false; past the pressure point nothing compacts until `auto` is on or `/lcm compact` runs.
- **Forgetting the `scope` equivalence.** `scope: "sessions"` and `"all_sessions"` read the same global sidecar directory; neither reaches outside it.
- **Expecting the raw transcript from the reader.** `lcm_expand_query` returns answers from the stored originals, never the transcript; ask for verbatim quotes when the exact words matter.
- **Looking for a delete command.** Forgetting is file deletion: remove that session's sidecar file; there is no delete tool.
