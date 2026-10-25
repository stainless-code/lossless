# opencode-lossless

**Lossless Context Management (LCM) for OpenCode v2. Long sessions keep working past the point where the model would forget, and every verbatim message stays searchable and readable.**

Install it, and the adapter mirrors every prompt, assistant reply, and tool exchange into a per-session SQLite sidecar. The model reads that history back through `lcm_grep`, `lcm_describe`, and `lcm_expand`; with `assembly` true (the default) it also gets `lcm_expand_query`, which answers through a child session without pulling the originals into the parent. With assembly on, the adapter also owns the context boundary: past the swap point the DAG projection replaces the aged history, and when the host compacts, the adapter hands it the frontier as the checkpoint instead of letting it summarize.

This package is the OpenCode v2 adapter over
[`lossless-core`](https://npmx.dev/package/lossless-core), the engine that
ingests the history and builds the summaries. Verified against OpenCode v2 in
live sessions: the plugin loads from its directory, all mirrored text matches
verbatim, and host compactions store the DAG frontier as their checkpoint.

## Install

```sh
opencode plugin add opencode-lossless
```

The equivalent entry in `opencode.json`:

```json
{
  "plugins": [{ "package": "opencode-lossless", "options": { "sidecarDir": "./.lossless" } }]
}
```

## Quick start

Zero config required: passive mirroring starts immediately, and swaps begin
once context crosses the swap point. Eleven commands, all `lossless-*`:

```sh
/lossless-status    # message and compaction summary counts per live sidecar
/lossless-report    # this session's metrics: projection, checkpoint, pass, recall, reader
/lossless-pass      # run one DAG pass over the aged span now, without waiting for the swap
/lossless-heal      # dry-run repair of tainted summaries; --apply spends model calls
/lossless-backup    # copy this session's sidecar beside it
/lossless-export    # write the verbatim transcript and summaries as JSONL (mode 0600)
/lossless-import    # restore rows from an export
/lossless-diagnose  # redacted, pasteable diagnostics block; --save writes it at mode 0600
/lossless-migrate   # upgrade older-schema sidecars in place (dry-run by default)
/lossless-gc        # list old sidecars, or export and delete them (never the current session)
/lossless-dump      # read-only dump of this session's sidecar; --include-removed keeps removed rows, --save writes mode 0600
```

The model gets four recall tools: `lcm_grep` (search this session, `scope`
reaches past sessions, `role`, `date_start`, `date_end`, and `tool_name`
filter rows), `lcm_describe` (inspect one summary without expanding
it), `lcm_expand` (read the originals a summary covers, `anchor` centers
the listing on one entry), and
`lcm_expand_query` (a bounded child session reads and answers, so the
originals never enter the parent's context).

## Config

```json
{
  "enabled": true,
  "sidecarDir": "./.lossless",
  "assembly": true
}
```

`sidecarDir` holds one SQLite file per session (0700 dir, 0600 files; delete
one to forget that session). `assembly: false` leaves compaction to the host
and drops `/lossless-pass` and `lcm_expand_query`. Every other key (thresholds,
summarizer chain and budgets, heal window, reader timeout) lives on the
[config reference](https://stainless-code.com/lossless/reference/opencode/config)
with its default.

## Verify

From a checkout of this repo:

```sh
bun run opencode:check   # read-only: host version, config, bundle hash, sidecar counts
bun run opencode:smoke   # one real model call, asserts the verbatim mirror
bun run opencode:compact # compaction gate, makes real model calls
```

## Documentation

|                                                                                 |                                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [The docs site](https://stainless-code.com/lossless/)                           | How LCM behaves in a session, the config keys, the limits |
| [Commands](https://stainless-code.com/lossless/reference/opencode/command)      | What each `/lossless-*` command does                      |
| [Comparison](https://stainless-code.com/lossless/reference/opencode/comparison) | The competing engines on one set of axes, verified cells  |
| [CHANGELOG.md](./CHANGELOG.md)                                                  | Version history (changesets)                              |

## Credits

- **Lossless Context Management (LCM)**, the algorithmic specification this
  package implements: "Lossless Context Management", Clint Ehrlich and
  Theodore Blackman, Voltropy PBC, <https://papers.voltropy.com/LCM>.
- **"Smart zone"**, the framing that model quality degrades at a token
  budget, not at the context-window limit, Matt Pocock, AI Coding
  Dictionary, <https://www.aihero.dev/ai-coding-dictionary/smart-zone>.
- All code is an original implementation written from the paper's spec.

## License

MIT, see [LICENSE](./LICENSE).
