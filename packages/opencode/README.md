# opencode-lossless

Lossless Context Management for OpenCode v2, built on
[`lossless-core`](https://npmx.dev/package/lossless-core). The adapter mirrors
every prompt, assistant reply, and tool exchange into a per-session SQLite
sidecar. The model reads that history back through `lcm_grep`, `lcm_describe`,
and `lcm_expand`; with `assembly` true (the default) it also gets
`lcm_expand_query`, which answers through a child session without pulling the
originals into the parent.

With assembly on, the adapter also owns the context boundary: once a request
crosses the swap point, the DAG projection replaces the aged history, and when
the host compacts, the adapter hands it the frontier as the checkpoint instead
of letting it summarize. With `assembly: false`, the host compacts natively.
Either way the sidecar keeps every address the reader can name, including the
compaction summaries.

Verified against OpenCode v2.1.3 in live sessions: the plugin loads from its
directory; prompt text, assistant text, tool input and result, and a manual
compaction mark with its summary text all mirror verbatim; `lcm_grep` answers
from the sidecar; and auto-compaction ran after a project config narrowed the
window to 6k tokens. Compaction marks and summaries keep distinct ids across a
plugin reload. In the live run, the host stored the DAG frontier as its
checkpoint with the adapter's marker on the message, and the next request
re-applied it.

## Install

Install it with the OpenCode CLI, which adds the `plugins` entry to the global
config:

```sh
opencode plugin add opencode-lossless
```

The equivalent entry is:

```json
{
  "plugins": [
    {
      "package": "opencode-lossless",
      "options": { "sidecarDir": "./.lossless" }
    }
  ]
}
```

## Live loop

From the checkout:

```sh
bun run pack           # build the bundle the host loads
bun run opencode:check # read-only: host version, config, bundle hash, sidecar counts
opencode2 plugin list  # confirms the host loaded this checkout's dist/index.mjs
bun run opencode:smoke # one real model call through the running server
bun run opencode:compact --mode manual # compaction gate, makes model calls
```

`bun run opencode:check` makes no model calls. It prints the host version, the
config path, the plugin entry resolved from the config document's directory,
the bundle's sha256 and mtime, the resolved sidecar directory, and one line per
store with message counts by role, the compaction summary count, and the newest
entry. It takes `--json` and `--limit N`. The live scripts require an absolute
`sidecarDir` in the plugin options, because the host resolves a relative one
from its own working directory.

The server watches the configured plugin directory and reloads it after
`bun run pack`. If a change does not take effect, run `opencode2 reload`; a
service restart is the fallback.

`bun run opencode:smoke` sends `Reply with exactly: pong.` through
`opencode2 run` in a temporary directory, then asserts that the session sidecar
holds a user row and an assistant row with the reply, that the sidecar
directory is 0700, and that the database files are 0600. It deletes the sidecar
afterwards unless `--keep` is passed. `--model provider/model[#variant]`
overrides the model, which defaults to the config's `model`. The npm free tier
rejects CLI runs, so the smoke does not default to a free model.

`bun run opencode:compact` is the compaction gate, and it makes real model
calls. `--mode manual` asks for a compaction through the API, waits for the
step boundary to store a mark and a summary, reloads the plugin, then compacts
again and asserts that both runs left distinct ids and that the first rows
survived. `--mode auto` (the default is manual) writes a temporary project
config with a 6k token window and auto-compaction, then sends a long prompt
until the host compacts on its own. Both modes assert the 0700 directory and the
0600 database files, delete the sidecar unless `--keep` is passed, and take
`--model` and `--timeout-ms`. Auto mode uses `--model`, or the script's fallback
model when none is passed; manual mode uses `--model`, then the config's
`model`, then the script fallback.

## Config

```json
{
  "enabled": true,
  "sidecarDir": "./.lossless"
}
```

`enabled` is a master flag and defaults to true. Listing the plugin is intent
enough, while `false` registers nothing. `sidecarDir` holds one SQLite file
per session and is created when missing. It defaults to `./.lossless`,
resolved from the server working directory. Delete a sidecar to forget that
session. The mirror never writes to the session record. With assembly on, the
host stores the checkpoint summary and its marker on the compaction message.

`assembly` (default true) wires the context boundary. It registers the
`session.context` projection, the blocking `session.compaction` checkpoint,
`lcm_expand_query`, and the `/lossless-pass` command. The projection swaps the
aged history for the DAG frontier at `swapAtRatio` (default 0.7) and re-cuts at
`recutAtRatio` (default 0.85); `keepRecentTokens` (default 20000) is the
verbatim tail, `summaryTokens` (default 1500) the render budget, `contextWindow`
(default 128000) the window used when the catalogue cannot name one, `smartZone`
and `zones` override the thresholds, and `summarizer` names the model chain,
where `auto` is the session model. This host exposes no synchronous model
lookup, so a concrete model id in the chain falls back to the session model.
`summarizerTokensPerCall` (default 60000) caps one request, estimate plus output
cap, before it is refused rather than paid for; `summarizerTokensPerPass`
(default 250000) caps what one pass may spend across its calls.
`summarizerTokensPerHeal` (default 120000) caps what one
`/lossless-heal --apply` run may spend across its calls; a dry run spends
nothing. `healSourceTokens` (default 8x `summaryTokens`, clamped 3000 through
24000 and to `summarizerTokensPerCall`) is the whole-node source window one
repair may read. A clipped or derived node over that window is blocked without
a model call, not retried at the same size; a mechanical node gets one
improvement. Set the option when a stored message is larger than the derived
window.
`readerTimeoutMs` (default 120000) is how long one expand-query child may run
before it is interrupted. A malformed value keeps its default rather than
failing the plugin load. Set `assembly: false` to leave compaction to the host.

## What the model gets

Three tools always, and a fourth by default; `assembly: false` leaves three.
`lcm_grep`, `lcm_describe`, and `lcm_expand` use the same recall vocabulary as
the Pi adapter; the OpenCode descriptions add scope and session text.
`lcm_expand_query` matches Pi's tool: it runs a bounded
reader and returns findings, so the raw originals never enter the parent's
context.

- `lcm_grep`: full-text search over the calling session's stored history.
  Each hit names the summary that covers it. `scope: "sessions"` or
  `"all_sessions"` searches the other sidecars in the directory; OpenCode keeps
  one global sidecar directory, so the two scopes are equivalent today and no
  project index is kept. A past-session hit is labelled `[lcm:session <id>]`
  and capped at 20 store files, 40 hits, and 1.5 s.
- `lcm_describe`: inspect one summary without expanding it. This reads the
  calling session only.
- `lcm_expand`: read the original messages a summary covers, or one named
  entry. Pass `session` with an `[lcm:session <id>]` hit to read that past
  session's sidecar read-only; the text comes back labelled as a past
  session's history.
- `lcm_expand_query` (assembly default): recover compacted history and answer a
  question about it. Pass `summary_id` or `entry_id` to read that source, or
  neither to search first. `max_tokens` (default 10000, clamped to 500..40000)
  sets the budget stated in the brief, and `readerTimeoutMs` bounds the child's
  run. The reader is session-scoped in this version: it reads the calling
  session's history, not a past session's, and the child's recall tools refuse
  `scope: "sessions"` and a past `session` argument.

The reader is an ordinary child session created against the parent. It runs
the host's `explore` agent with a session ruleset that denies everything and
then allows only `lcm_grep`, `lcm_describe`, and `lcm_expand`; the
`session.context` hook replaces its system prompt with the reader instructions
and skips the projection and checkpoint. Its recall tools resolve to the
parent's sidecar. The parent's `lcm_expand_query` waits for the child, reads
the last assistant text, redacts it, removes the child, and deletes the child's
transcript sidecar. A named summary or entry the store does not hold is refused
before a child exists. The reader is session-scoped, so there is no past-session
reader, and there is no per-child token or step cap: the child's model decides
how much it reads within the brief.

Ten commands by default; `/lossless-pass` is absent with `assembly: false`:

- `/lossless-status`: report the message and compaction summary counts per live
  sidecar. A command cannot return text directly, so the status arrives as a
  prompt the loop answers from.
- `/lossless-report`: summarize this session's rows in `metrics.jsonl`:
  projection decisions with their top bail and kick reasons, checkpoints with
  the last summary ids and text size, pass outcomes with leaf and condensed
  totals, summary node counts with the level-3 fallback share and node latency,
  summarizer usage, errors, caps, and estimated counts, abandoned pass counts,
  heal runs, recall calls per tool, reader runs with their average duration, and
  the last decision's action and occupancy.
- `/lossless-pass`: run one DAG pass over the aged span now, without waiting for
  the swap threshold.
- `/lossless-heal [--apply] [--max-nodes <n>]`: repair tainted summaries from
  their stored sources. Dry-run by default and makes no model call; `--apply`
  spends model calls, and `--max-nodes` overrides the engine's 32-node cap.
- `/lossless-backup [path]`: copy this session's sidecar beside it, or to the
  path you name.
- `/lossless-export [path]`: write the verbatim transcript and summaries as
  JSONL, mode 0600. The default lands beside the sidecars.
- `/lossless-import <path>`: restore rows from an export. Refused while a pass
  is running, or into a store that already holds foreign messages.
- `/lossless-diagnose [--save <path>] [--repair]`: build a redacted, pasteable
  diagnostics block; `--save` writes it at mode 0600, and `--repair` rebuilds
  the full-text index first.
- `/lossless-migrate [--apply]`: upgrade older-schema sidecars in place.
  Dry-run by default.
- `/lossless-gc [--older-than <days>] [--session <id>] [--apply]`: list old
  sidecars, or export and delete them. Never touches the current session.

`gc` is age-based because the plugin API cannot list host sessions: it defaults
to 30 days, never touches the current session, and exports each transcript
before deleting it.

There is no cockpit: the promise plugin API has no interactive TUI surface. A
separate TUI plugin could add one.

## How it works

The plugin mirrors four boundaries into the sidecar, each under a stable
entry id, so a redelivered event inserts nothing:

| Boundary                                                  | Entry                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `session.prompt` hook                                     | the user text plus attached file names                                      |
| `session.text.ended` bus event                            | each assistant text block at its full-value boundary                        |
| `tool.execute.after` hook                                 | the tool name, the input that caused it, and the result or error text       |
| `session.compaction` hook plus `session.compaction.ended` | a checkpoint mark naming what left the window, then the summary text itself |

Only text is stored. Media, reasoning, and streaming deltas stay out, which
matches what the model saw as text. Native checkpoints that publish an empty
summary are skipped because there is nothing to store.

With assembly enabled (the default), the same compaction hook is the blocking boundary. It reads
the stored history, cuts the aged prefix the way the projection does, and hands
the host the frontier render as `event.result.summary` plus a marker
(`lcm`, `summaryIds`, `cutCount`, `checkpoint`, `keepID`). The host stores the summary and
the marker on the compaction message, so the next request's projection
recognizes its own checkpoint by the marker, not by the text, and re-applies the
host's rendering of it. A checkpoint the adapter did not write leaves the
request alone. If the frontier does not cover the aged span the hook runs one
pass and waits; a failed pass leaves the result unset so the host summarizes
natively, and records a `compaction-checkpoint` metric row.

Every seam writes a row to `metrics.jsonl` beside the sidecars: one
`projection` decision per request, one `compaction-checkpoint` per boundary,
one `pass` per summarizer run, one `recall` per recall-tool call, and one
`reader` per expand-query child with its outcome, duration, answer size, and
cited ids. The engine and summarizer rows a pass causes (`summary-stored`,
`summarizer-usage`, `compaction-complete`, summarizer errors and caps, and
abandoned counts) land in that same OpenCode log through the pass's sink, not
in Pi's metrics file. A heal writes `heal-start`, `heal-node`, and
`heal-complete` rows to the same log. The log is created 0600 in a 0700 directory, rotates to
`metrics.jsonl.<timestamp>` at 5 MB, keeps three generations, and a read skips
a missing file or a malformed line. `/lossless-report` renders it per session.

The published bundle names no host SDK. `src/host.ts` is the whole part of
the plugin API this package uses, written as local structural types, and
`test/host-compat.test.ts` assigns the real host types to each one. A host
upgrade that changes the API fails typecheck instead of packing a silent
mismatch.

## Security notes

- Sidecars are plaintext SQLite files under `sidecarDir`. The directory is
  created 0700, and the database, WAL, and shared-memory files are 0600. A
  sidecar holds the session's secrets verbatim, so it deserves the same care
  as the session itself.
- Redaction is best-effort pattern matching, not a hard boundary. It runs on
  the way out, at every tool that hands stored text to a model, and it never
  touches a stored row.
- Recall tools read the calling session's sidecar, except inside an
  expand-query child, which reads its parent's. A `lcm_grep` scope of
  `sessions` or `all_sessions` opens other sidecars through a `queryOnly`
  handle, so a scan never rewrites a session it is only reading, and
  `lcm_expand` with `session` reads the same way. A session with no history
  gets an explanation, not an empty result, and a lookup never creates a store. The
  child's own sidecar is a transcript and is deleted with the child.

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
