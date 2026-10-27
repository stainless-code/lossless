---
name: opencode-lossless
description: "Use when an OpenCode v2 session has opencode-lossless installed: read compacted history with lcm_grep, lcm_describe, lcm_expand, or lcm_expand_query; run /lossless-status, /lossless-report, /lossless-pass, /lossless-heal, /lossless-backup, /lossless-export, /lossless-import, /lossless-diagnose, /lossless-migrate, /lossless-gc, or /lossless-dump; or tune the swap point."
license: MIT
metadata:
  type: composition
  library: "opencode-lossless"
  library_version: "0.1.2"
requires:
  - lossless
sources:
  - stainless-code/lossless:packages/opencode/src
---

# opencode-lossless

Passive mirroring starts with no configuration. The adapter stores every prompt, assistant reply, and tool exchange in a per-session SQLite sidecar. Past the swap point the DAG projection replaces aged history, and on host compaction the adapter hands over the frontier as the checkpoint instead of a summary.

## Install

```sh
opencode plugin add opencode-lossless
```

Equivalent `opencode.json` entry:

```json
{ "plugins": [{ "package": "opencode-lossless" }] }
```

To keep sidecars inside the project, set `sidecarDir` to `"./.lossless"`.

## Commands

- `/lossless-status`, message and compaction summary counts per live sidecar.
- `/lossless-report`, this session's metrics: projection, checkpoint, pass, recall, reader.
- `/lossless-pass`, run one DAG pass over the aged span now, without waiting for the swap.
- `/lossless-heal`, dry-run repair of tainted summaries. `--apply` spends model calls.
- `/lossless-backup`, copy this session's sidecar beside it.
- `/lossless-export`, write the verbatim transcript and summaries as JSONL (mode 0600).
- `/lossless-import`, restore rows from an export.
- `/lossless-diagnose`, redacted, pasteable diagnostics block. `--save` writes it at mode 0600.
- `/lossless-migrate`, upgrade older-schema sidecars in place (dry-run by default).
- `/lossless-gc`, list old sidecars, or export and delete them (never the current session).
- `/lossless-dump`, read-only dump of the session sidecar. `--include-removed` keeps removed-branch rows, `--save` writes the output to a file at mode 0600.

## Recall tools

- `lcm_grep` searches full text over this session, and `scope` reaches past sessions. `role` keeps only rows stored with that role, `date_start` and `date_end` bound rows by timestamp, and `tool_name` keeps only tool-result rows for that tool.
- `lcm_describe` inspects one summary (kind, costs, children) without expanding it.
- `lcm_expand` reads the verbatim originals a summary covers, and `anchor` centers the listing on one entry.
- `lcm_expand_query` runs a bounded child session that reads and answers, so originals never enter the parent context.

## Config essentials

```json
{ "enabled": true, "sidecarDir": "./.lossless", "assembly": true }
```

The example stores sidecars in the project. Without `sidecarDir`, the plugin uses the global auto-detected path, which holds sessions from every project. The config reference lists the exact paths at https://stainless-code.com/lossless/reference/opencode/config

- `sidecarDir` holds one SQLite file per session (0700 dir, 0600 files). Delete one to forget that session. After upgrading a project that used `./.lossless`, keep `sidecarDir` set to `"./.lossless"` to keep that history: `/lossless-migrate` works in place in the configured directory only (dry run by default, moves nothing). To carry history elsewhere, `/lossless-export` each session under the old config and `/lossless-import` into an empty store under the new one, or stop the server first and copy the `.sqlite`, `-wal`, and `-shm` files across and then migrate.
- `assembly: true` (default) owns the context boundary. Projection swaps aged history and compaction stores the DAG frontier.
- The config reference documents every other key and its default: swap thresholds, summarizer chain and budgets, heal window, and reader timeout. See https://stainless-code.com/lossless/reference/opencode/config

## Verify

From a checkout of this repo (these scripts only exist there, not in a consumer project):

```sh
bun run opencode:check   # read-only: host version, config, bundle hash, sidecar counts
bun run opencode:smoke   # one real model call, asserts the verbatim mirror
bun run opencode:compact # compaction gate, makes real model calls
```

## Common mistakes

- **`assembly: false` drops `/lossless-pass` and `lcm_expand_query`.** Keep the default `true` unless the host must own compaction. With `false`, compaction falls back to the host.
- **`scope` equivalence.** `scope: "session"` (default) reads this session only. Pass `scope: "sessions"` or `"all_sessions"` to reach past sessions.
- **Reader is session-scoped.** `lcm_expand_query` returns findings only through its child session, never the raw transcript. Ask a question it can answer from the sources, not for a dump.
- **Forgetting is file deletion.** Remove that session's sidecar file. There is no delete tool.
- **Expecting host compaction to summarize.** With assembly on, the checkpoint is the DAG frontier, not a prose summary. Read it with `lcm_describe`, not by asking the host.
