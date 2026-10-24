---
name: opencode-lossless
description: Lossless Context Management for OpenCode v2 (opencode-lossless). Per-session SQLite sidecar mirrors every prompt, reply, and tool exchange; recall with lcm_* tools; DAG projection replaces aged history past the swap point.
license: MIT
metadata:
  type: composition
  library: "opencode-lossless"
  library_version: "0.1.1"
requires:
  - lossless
sources:
  - stainless-code/lossless:packages/opencode/src
---

# opencode-lossless

Passive mirroring starts with zero config: every prompt, assistant reply, and tool exchange lands in a per-session SQLite sidecar. Past the swap point the DAG projection replaces aged history, and on host compaction the adapter hands over the frontier as the checkpoint instead of a summary.

## Install

```sh
opencode plugin add opencode-lossless
```

Equivalent `opencode.json` entry:

```json
{ "plugins": [{ "package": "opencode-lossless", "options": { "sidecarDir": "./.lossless" } }] }
```

## Commands

- `/lossless-status` — message and compaction summary counts per live sidecar.
- `/lossless-report` — this session's metrics: projection, checkpoint, pass, recall, reader.
- `/lossless-pass` — run one DAG pass over the aged span now, without waiting for the swap.
- `/lossless-heal` — dry-run repair of tainted summaries; `--apply` spends model calls.
- `/lossless-backup` — copy this session's sidecar beside it.
- `/lossless-export` — write the verbatim transcript and summaries as JSONL (mode 0600).
- `/lossless-import` — restore rows from an export.
- `/lossless-diagnose` — redacted, pasteable diagnostics block; `--save` writes it at mode 0600.
- `/lossless-migrate` — upgrade older-schema sidecars in place (dry-run by default).
- `/lossless-gc` — list old sidecars, or export and delete them (never the current session).

## Recall tools

- `lcm_grep` — full-text search over this session; `scope` reaches past sessions.
- `lcm_describe` — inspect one summary (kind, costs, children) without expanding it.
- `lcm_expand` — read the verbatim originals a summary covers.
- `lcm_expand_query` — a bounded child session reads and answers, so originals never enter the parent context.

## Config essentials

```json
{ "enabled": true, "sidecarDir": "./.lossless", "assembly": true }
```

- `sidecarDir` holds one SQLite file per session (0700 dir, 0600 files; delete one to forget that session).
- `assembly: true` (default) owns the context boundary: projection swaps aged history and compaction stores the DAG frontier.
- Every other key (swap thresholds, summarizer chain and budgets, heal window, reader timeout) lives on the config reference with its default.

## Verify

```sh
bun run opencode:check   # read-only: host version, config, bundle hash, sidecar counts
bun run opencode:smoke   # one real model call, asserts the verbatim mirror
bun run opencode:compact # compaction gate, makes real model calls
```

## Common mistakes

- **`assembly: false` drops `/lossless-pass` and `lcm_expand_query`** — compaction falls back to the host.
- **`scope` equivalence** — `scope: "session"` (default) reads this session only; past sessions need explicit scope.
- **Reader is session-scoped** — `lcm_expand_query` answers through a child session and returns findings only, never the raw transcript.
- **Forgetting is file deletion** — remove that session's sidecar file; there is no delete tool.
- **Expecting host compaction to summarize** — with assembly on, the checkpoint is the DAG frontier, not a prose summary.
