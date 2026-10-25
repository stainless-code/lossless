---
name: pi-lossless
description: "Use when a Pi session has pi-lossless installed: search compacted history with lcm_grep, lcm_describe, or lcm_expand_query; run /lcm status, settings, backup, export, report, doctor, gc, migrate, heal, dump, or diagnose; or tune compaction thresholds."
license: MIT
metadata:
  type: composition
  library: "pi-lossless"
  library_version: "0.1.2"
requires: []
sources:
  - stainless-code/lossless:packages/pi/src
---

# pi-lossless

Aged conversation becomes DAG summaries the model can navigate; the full
verbatim history stays searchable and recoverable. Session file is never
modified; the store (`~/.pi/agent/lcm/`, plaintext SQLite, chmod 0600) is a
derived index that can be deleted and rebuilt.

## Install

```bash
pi install npm:pi-lossless
```

Passive logging starts immediately with zero config; swaps begin past the
soft threshold (default 70% of the model window).

## /lcm subcommands

- `/lcm` — same as `/lcm status` (default subcommand).
- `/lcm status` — current projection state: messages, pin, occupancy, thresholds.
- `/lcm settings` — the LCM Cockpit: live gauge, cycle-edit every threshold (TUI only).
- `/lcm backup` — copy the live store to a timestamped file.
- `/lcm export` — write the full store as JSONL (verbatim bytes, secrets included).
- `/lcm report` — metrics summary for the current session.
- `/lcm dump` prints a read-only dump of the session sidecar. `--include-removed` keeps removed-branch rows and `--save <path>` writes the file at mode 0600.
- `/lcm doctor` — diagnostics: store checks, thresholds, summarizer chain, footprint; `--repair` rebuilds the index and drops unreachable rows.
- `/lcm gc` — dry-run list of retired stores; `--apply` exports then DELETEs them (destructive; export lands beside the stores).
- `/lcm migrate` — dry-run list of older-schema stores; `--apply` upgrades them in place for cross-session search.
- `/lcm heal` — dry-run repair of tainted summaries; `--apply` spends model calls, `--max-nodes <n>` bounds the run.
- `/lcm diagnose` — one pasteable block for a bug report; `--save <path>` writes it to a file (mode 0600, capped at 8 KB, no message bodies).

## Recall tools

- `lcm_grep` searches ALL history, including compacted-out content. `query` is full-text over the token index (words, quoted phrases, `AND`/`OR`, prefixes; first 100,000 chars per message). `pattern` is a case-insensitive regex over full text (up to 200,000 chars per message, 1s cap per call). Use it for pointers, calls, punctuation, or spans the index cannot hold. Hits page 20 at a time via `offset`; `query` reports a total, `pattern` reports whether more exist. `summary_id` scopes to one node; `scope: "sessions"` / `"all_sessions"` reaches past sessions. `role` keeps only rows stored with that role, `date_start` and `date_end` bound rows by timestamp, and `tool_name` keeps only tool-result rows for that tool.
- `lcm_describe` — inspect a summary: what reading its originals would cost and which files it covers.
- `lcm_expand_query` — bounded reader over stored originals; returns findings without that text entering the main conversation. Default budget 10,000 tokens over at most 6 reader turns; `max_tokens` changes the per-call budget. `summary_id` reads one node, `entry_id` one message. Cross-session: `lcm_expand_query({ session: "<hash>", entry_id: "<id>" })` on a grep hit; findings are tagged as past-session history. Unknown ids are refused before any model call.

Reach for recall tools when the answer is in history; reach for subcommands when acting on the store (backup, repair, migrate, gc, diagnose).

```ts
lcm_grep({ query: "migration plan", scope: "sessions", limit: 20 });
```

## Config (`~/.pi/agent/lcm.json`, strict JSON)

```json
{
  "smartZone": 110000,
  "zones": {
    "openrouter/z-ai/glm-5.3-flash": { "swapAtTokens": 110000, "recutAtTokens": 130000 }
  },
  "swapAtRatio": 0.7,
  "recutAtRatio": 0.85,
  "summarizer": ["openrouter/z-ai/glm-5.3-flash", "anthropic/claude-haiku-4-5", "auto"]
}
```

- `smartZone`: easy mode, one number; recut derived (x1.18).
- `zones`: per-model overrides keyed `"provider/id"` (thresholds only); explicit tokens beat ratios.
- `swapAtRatio` / `recutAtRatio`: ratio mode, the default when no token thresholds are set.
- `summarizer`: one model or an ordered fallback chain. No comma form (ids may contain commas). `auto` is the session model only, never "something cheap"; unset behaves as `auto`. Tried in order on missing/failing/empty output; failures demote to the back for the pass. `/lcm doctor` prints the chain that actually runs.
- Corrupt file is left untouched with defaults applied; out-of-range numbers and wrong types are ignored. Overwrites back up to `lcm.json.bak`.
- Full key list (largeFileChars, per-call and per-pass budgets, heal budgets, redaction flag) with defaults: https://stainless-code.com/lossless/reference/pi/config

## Common mistakes

- **Expecting the settings UI outside the TUI** — `/lcm settings` is an interactive cockpit; in print/RPC mode there is no live gauge, use `/lcm status` and `/lcm doctor`.
- **`query` vs `pattern` confusion** — `query` cannot see punctuation, ids, or spans; anything a pointer, call signature, or exact span needs must be `pattern`.
- **Assuming cross-session search is unbounded** — stops at 20 stores, 40 hits, or 1.5s, whichever comes first; older-generation stores are counted, not read, until `/lcm migrate`.
- **Treating a gc transcript as searchable** — a store `/lcm gc` deletes is no longer readable by any scope; the export beside the stores keeps bytes only.
- **Disabling redaction and expecting disk changes** — `redactSecrets: false` (config flag, default on) affects outbound reads only; stored rows are never rewritten.
