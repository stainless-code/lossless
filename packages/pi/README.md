# pi-lossless

**Lossless Context Management (LCM) for the Pi coding agent. Nothing is ever lost, and the model sees less.**

Install it, and a long session keeps working past the point where the model would
normally forget, while you can still read what it forgot. The extension
implements the LCM architecture (Ehrlich & Blackman, Voltropy). Aged
conversation becomes DAG summaries the model can navigate, while the full
verbatim history stays searchable and recoverable through `lcm_grep` /
`lcm_describe` / `lcm_expand_query`. Your session file is never modified, and the
store is a derived index you can delete and rebuild.

This package is the Pi adapter over
[`lossless-core`](https://npmx.dev/package/lossless-core), the engine that
ingests the history and builds the summaries.

## Install

```bash
pi install npm:pi-lossless
```

## Quick start

Zero config required, passive logging starts immediately, and swaps begin
once context crosses the soft threshold (default: 70% of the model's window).

```bash
/lcm status     # current projection state (messages, pin, occupancy, thresholds);
                # the default subcommand, so bare /lcm is this
/lcm settings   # the LCM Cockpit, live gauge, cycle-edit every threshold
/lcm backup     # copy the live store to a timestamped file
/lcm export     # write the full store as JSONL (verbatim; see Security notes)
/lcm report     # metrics summary for the current session
/lcm doctor     # diagnostics: store checks, thresholds, summarizer chain,
                # footprint; add --repair to rebuild the index and drop the rows
                # nothing can reach
/lcm gc         # dry-run list of retired stores; add --apply to export then
                # DELETE them (destructive; the export is written beside the
                # stores as lcm-export-gc-<timestamp>.jsonl before any deletion)
/lcm migrate    # dry-run list of stores left at an older schema; add --apply to
                # upgrade them in place so cross-session search can read them
/lcm diagnose   # one pasteable block for a bug report (see Reporting a problem);
                # add --save <path> to write it to a file instead
```

The model gets three recall tools: `lcm_grep` (search across ALL history,
including compacted-out content, and with `scope` across past sessions),
`lcm_describe` (inspect a summary, what reading its originals would cost, and the
files it covers), and `lcm_expand_query` (read the stored originals and answer
from them). Every summary in context carries an engine-written
`[lcm:summary #3 depth 0 span e12..e40]` header, and every grep hit names the
summary that covers it.

`lcm_grep` takes one of two things. `query` is a full-text search over the
token index: words, quoted phrases, `AND`/`OR`, prefixes. `pattern` is a
regular expression over the full text of every message, which is what a pointer,
a call, or a span needs, because an index cannot hold punctuation. A pattern is
case-insensitive unless `case_sensitive` is set. Both paths page: hits come 20
at a time, `offset` reaches the next page, and the query path reports its total
while the pattern path says whether more matches exist rather than claiming a
count it did not compute.

All three take an address when you have one, so a known id does not have to be
searched for: `lcm_grep` accepts `summary_id` to search inside one node, and
`lcm_expand_query` accepts `summary_id` to read a node's originals or
`entry_id` to read one message. An address the store does not hold is refused
before any model call.

`lcm_expand_query` runs a bounded reader: it expands the summaries in its own
context and returns findings, so a 200,000-character message is readable
without that text entering the main conversation. The default budget is 10,000
tokens of retrieved content over at most 6 reader turns; `max_tokens` changes
the budget per call.

## Cross-session recall

A new session starts empty. `lcm_grep` reaches the ones before it with
`scope`: `"sessions"` searches this project's past sessions, `"all_sessions"`
every project, and both walk the most recent 20 past sessions and grep their
stores under a wall-clock deadline. Nothing is injected: a hit from a past session is a
pointer, labelled with that session, its date and its working directory, and the
model reads it with `lcm_expand_query({ session: "<hash>", entry_id: "<id>" })`,
which returns findings tagged as a past session's history. Cross-session recall
is therefore always a tool call the model chose, never text that appeared by
itself. A search stops at 20 stores, 40 hits, or 1.5 seconds, whichever comes
first.

The scan reads session files for their one-line header (`cwd`, id, timestamp)
and opens their stores read-only, so it never migrates, repairs or writes
anything it searches. A store written by an older build cannot answer this
build's queries and is counted as `older-generation` rather than upgraded in
place: `/lcm migrate` upgrades those stores, and a store becomes searchable
without it as soon as its own session next runs.

A store `/lcm gc` deletes stops being reachable by later searches: it is not only
that session's index, it is a past session the cross-session scope can no longer
read. The transcript export gc writes before deleting keeps the bytes, and
nothing re-indexes it. That export goes beside the stores it protects, next to
`/lcm backup`'s copies, never into the directory Pi was started from: it holds
stored bytes, secrets included.

## Config (`~/.pi/agent/lcm.json`)

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

- `smartZone`: easy mode, one number: swap at that many tokens; the recut
  point is derived (× 1.18).
- `zones`: per-model threshold overrides, keyed `"provider/id"` (thresholds
  only).
- `swapAtRatio` / `recutAtRatio`: ratio mode, the default when no token
  thresholds are set.
- `summarizer`: one model (`"provider/id"`) or an ordered fallback chain. There
  is no comma form, because a model id may contain a comma. `auto` is the
  session model and nothing else, so it never means "pick something cheap".
  Unset behaves as `auto`. The chain is tried in order on a model that is
  missing, fails, or returns no text, and the session model is the last resort
  unless the chain already names it. An entry that fails is demoted to the back
  of the order for the rest of that compaction pass, so a broken primary is
  paid for once per pass rather than once per chunk. A failure is a throw, a
  response the
  provider marked `error`, or one that stopped at the token cap (`length`),
  which would otherwise store a half-finished summary. Duplicate and empty
  entries are dropped, and an entry the registry cannot find is reported once
  per session and recorded as a `summarizer-model` event. A chain that needed
  more than one model records a `summarizer-fallback` event, which `/lcm
report` shows as `model-fallback`. `/lcm doctor` prints the chain that
  actually runs, next to the config it came from, so `auto` expansion and the
  appended session model are visible rather than implied. A substitution also
  raises one UI warning per session.

- `largeFileChars` / `externalizeFiles`: a body read from a named path and at
  least this many characters long becomes a file handle (path, content id, kind,
  and a bounded preview) rather than a wall of text, and the summarizer reads
  the handle instead of a clipped body. The bytes stay in the message row.
  Default 32,000 characters, on.
- `summarizerTokensPerCall` / `summarizerTokensPerPass`: what one summarizer
  request may cost before it is refused instead of paid for, and what one pass may
  spend across all of its calls. The request's size is known before the call, so a
  refusal happens without a provider call, and the pass total counts what the
  provider reported. Both are backstops against a provider that answers and never
  stops, and a pass that respects `summaryTokens` and `leafChunkTokens` spends a
  fraction of either cap.
  A pass that crosses one finishes its remaining chunks with the mechanical
  truncate and records `summarizer-capped` with `source: "budget"`.

The file must be valid strict JSON, so `//` comments and trailing commas are
rejected, and a corrupt file is left untouched with defaults applied. A number
outside the range of its key is ignored like a wrong type, so a hand-edited
`"summaryTokens": 0` falls back to the default instead of condensing the whole
DAG on every pass. Anything the parse had to normalize or ignore is reported at
session start, or recorded as a `config-problem` metric when there is no UI to
report it in.
Threshold vocabularies are OR-mode per level (ratios / smartZone / token pair);
explicit tokens win. A safety clamp keeps the loop alive on small windows.

- An overwrite copies the file it replaces to `lcm.json.bak` first, and never
  replaces a backup that already exists, so a mistargeted write stays
  recoverable. Nothing else in LCM deletes this file.
- A process that looks like a test run (`NODE_ENV=test`, `VITEST`, or the
  `LCM_TEST_GUARD` the test setup sets) refuses to touch a home that is not a
  temp dir. `LCM_ALLOW_REAL_HOME=1` overrides that refusal for a live session
  that inherits a test signal.

## Reporting a problem

Run `/lcm diagnose` and paste the block it prints into the issue. It carries
what a diagnosis needs from this session and nothing else:

- this package's version, Pi's version, node, platform, arch, and the mode
  the session runs in (TUI, print or RPC)
- the store tag (which is also the `session` field on every metric row), the
  session file's basename, and the session file format version
- the store facts `/lcm doctor` prints: counts, size, integrity findings, the
  depth histogram, the pinned projection, the thresholds, the model and the
  summarizer chain
- the effective config, merged over the defaults, as JSON, and the config path
- this session's metrics: the row count, a tally by kind, the last context
  decision, and up to 25 of the most recent rows as JSONL, with the count it
  left out always printed

The block is capped at 8 KB. It carries no message body, no summary text, no
search query, and no absolute path outside your home directory; a path inside
it prints with `~`. Provider and host error text is masked (see Security
notes), so a key in a failure message cannot leave. Everything else in the
block is this package's own vocabulary: version numbers, counters, model ids,
entry ids and config values. Read it once before posting, and strip anything
personal.

A notification is rendered, not written, so your terminal wraps it and a copy
carries those breaks: a metric row can arrive split across two lines. Write the
same block to a file when the exact bytes matter, for example to attach it or
to parse the rows:

```
/lcm diagnose --save lcm-diagnose.txt
```

The file holds the bytes the notification would have carried, plus a final
newline, written at mode 0600; the notification names the path instead of
printing the block. `--save=<path>` is the same flag. `--save` with no path is
refused rather than quietly printing the block.

## Security notes

- Stores are plaintext SQLite files under `~/.pi/agent/lcm/`, chmod 0600. A
  store is the only copy of what the session produced, so it holds the secrets
  the session contained, verbatim and unrewritten.
- Redaction is best-effort pattern matching, not a hard security boundary. It
  runs on the way out, at every seam that hands stored text to a model, and it
  never touches a stored row. Provider key shapes are matched exactly. An
  assignment is rewritten when its value carries a digit, or when it is written
  the way an env file writes it (`KEY=value`, no space before the `=`). A secret
  of letters only, or a bare one broken up by punctuation such as a dot, passes
  through.
- `redactSecrets: false` disables masking on every outbound seam. It changes
  nothing on disk, because storage never consults it. A row that a read masks is
  still in the store, and a later read with the toggle off returns it.
- The session file is the source of truth: delete the store DB under
  `~/.pi/agent/lcm/` and restart to rebuild the index.
- `/lcm export`, `/lcm backup` and gc transcripts are store surfaces, so they
  carry the stored bytes, secrets included. They are your own data and deserve
  the same care as the original session file. An export carries committed
  memory, so a pass that is still running is not in it, and an import is refused
  until that pass finishes.
- Cross-session search reads files outside this session: line 1 of every session
  file in the sessions root (its `cwd`, id and timestamp, never a message), and
  the stores of the sessions that match the scope, opened read-only with writes
  forbidden on the connection. Findings pass the same redaction as in-session
  recall, and nothing from a past session is injected or stored into this one.
  `/lcm migrate` is the only path that writes to a past session's store, and it
  is explicit and dry-run by default.

## How it works

- **Passive logging** (always): every turn ingests messages idempotently into
  SQLite+FTS5, zero-cost continuity below the swap point.
- **Async regime**: past the swap point, the `context` hook swaps the aged
  head for a summary pointer between turns. Swaps are commit-batched, the
  projection stays byte-identical (pure appends, provider-cache-safe) until
  the recut line, then one monotonic re-cut.
- **Blocking regime**: at Pi's own compaction limit, LCM replaces default
  compaction with escalated DAG summaries. It never cancels, and on failure it
  falls back to the Pi default.
- **Recursive DAG** (paper §2.1): each compaction summarizes only the
  messages no leaf covers yet, then condenses the frontier one depth at a
  time. A group is a run of adjacent nodes that share a depth: the oldest such
  run at the shallowest depth that has one, at most `MAX_DAG_FANOUT` (8)
  children, repeated while the pointer block is over the summary budget.
  Nothing is summarized twice; every node expands back to its verbatim
  messages through provenance. The projection carries every frontier id: when
  the text does not fit the budget it is stubbed (header, a 200-character
  slice, and a note naming `lcm_describe`) rather than dropped, and a frontier
  that is still over budget is reported instead of resolved by eviction. The
  depth cap of 8 is a structural assert, not a policy, and with 8 children per
  node it covers 8^8 leaf chunks; a pass that cannot meet its budget records
  `condensation-stalled`. The engine writes `[lcm:summary #id depth d span
a..b]` next to every summary the model sees (paper §2.4).
- **Three-level escalation** (paper Fig. 3): preserve-details → bullets →
  deterministic truncate of the source text, accepted only on strict token
  reduction. Level 3 is stored like any other level (tagged
  `[lcm:truncated]`), which is what guarantees convergence. Level 2 keeps
  level 1's output budget instead of a fraction of it, because a smaller cap
  makes a reasoning model likelier to answer nothing, and level 3 already
  covers the floor. A node whose text lands over twice its target earns one
  level-2 make-smaller pass; the smaller text becomes the primary one and the
  thorough text is kept as the node's rich tier.
- **Recall is one delegation, not a context flood**: `lcm_grep` and
  `lcm_describe` run in the main loop, and reading originals goes through
  `lcm_expand_query`, whose reader expands them in its own context and returns
  findings. The reader reads at most `max_tokens` (default 10,000) over at most
  6 turns, and it pages inside a single message, so nothing stored is out of
  reach. Paper Appendix C restricts raw expansion to a sub-agent; Pi has no
  `Task` tool, so the reader is an in-process loop with its own context
  and no write access to the store.
- **Raw blocks**: the derived text is what the index and the summarizer read,
  and it is not always the whole message. A thinking block, an image, a
  signature, or a block type the renderer does not know is kept as a payload on
  the row, and a read returns it. A message whose derived text is complete
  carries no payload, so the common case stays one copy. Payload size is
  reported by `/lcm doctor`; a row written before this build keeps only the
  derived text, and deleting the store and restarting rebuilds it from the
  session file.
- **Tiered summaries**: when the ladder picks its terse rung over a thorough
  one, the node keeps the thorough text as a second tier. The projection serves
  the richest tier that fits its budget, so a frontier under pressure drops a
  node to its shorter text before it drops to a 200-character stub, and the
  pointer survives every rung. `lcm_describe` returns the thorough text and
  names both sizes.
- **File handles (paper §2.2)**: a tool result above `largeFileChars` whose call
  named a path becomes a file. The store keeps a descriptor (path, content id,
  the kind the body turned out to be, an exploration summary, and a bounded head
  of the body) beside the verbatim text, the summarizer reads that descriptor
  instead of a clipped body, and the handle propagates up the DAG, so
  `lcm_describe` on a condensed node lists the files its children cover, each
  with the first line of its summary. The exploration summary is built by rule,
  with no model call and no parser: code names its top-level declarations
  (`TypeScript, 240 lines; 18 top-level declaration(s): function compact, class
Engine, ...`), JSON names its shape and one level of nesting (`array of 412
objects, keys: id, name`), JSONL names its row keys, a table names its columns,
  Markdown names its headings, and text names its size and first line. A family
  with no rule reports its size rather than guessing, names are capped at 12 with
  `(+N more)`, and the whole summary line stays under a line of the preview. A body that large with no path is
  stored as ordinary text and recorded as `large-inline`, so "no files here" is
  told apart from a trigger that missed.
- **Procedural long-context evaluation (paper §4, §5)**: generated context of
  any length with a known answer. A seeded generator writes turns with needles
  (`N07=4821`) spread through them, the harness drives this build's own
  compaction passes over the result, and then asks two questions: is every needle
  still returned verbatim by address, covered by the DAG, and readable in one
  bounded reader window, and can a question that needs all of them still be
  answered from the surface a model sees without recall, with the recall path
  counted separately and a failure count that has to stay zero. One small seed
  runs in CI; longer ladders run on demand with `bun run eval` from a checkout of
  the repository, which prints one row per length and appends an `eval` metrics
  row per run.
- **Removed branches**: Pi's session tree can move the leaf, which takes entries
  out of context without deleting them. Those entries are marked and their
  bytes are kept: `lcm_grep` skips them unless `include_removed` is set, an
  included hit is labelled `[removed]`, and an addressed read returns the text
  with a marker. Navigating back clears the mark, so an abandoned branch
  becomes visible again.
- **Integrity**: `/lcm doctor` runs checks over the store (full-text
  index, summary spans, node shape, children that a committed node names,
  duplicate spans, foreign keys, recorded schema version, runs whose writer is
  gone, and how many messages have no leaf yet) and names a bounded sample of
  offending ids. `--repair` rebuilds the index, drops summaries whose span names
  an entry the store does not hold or whose child is gone, removes duplicate span
  rows, keeping the row that can still be expanded, and reaps the rows a run
  whose writer died left behind. A run this process wrote is left alone, and a
  row whose pid an unrelated process now holds reads as live, so it waits for
  that process to exit.
- **Telemetry**: `~/.pi/agent/lcm/metrics.jsonl` logs every context decision,
  per-message provider usage (fresh vs cached, cost), one row per summarizer
  call with the model, stage, and what the provider billed, one row per recall
  call, one per externalized file, and one per branch change.
  `/lcm doctor` reports the thresholds, the zone, and the summarizer chain that
  are in effect, which answers what the log recorded after the fact.
- **Verbatim storage**: message text is stored whole, whatever its size.
  `lcm_grep` with `query` matches the first 100,000 characters of a message,
  because that is what the token index holds; with `pattern` it reads every
  character, up to 200,000 per message and one second per call. A hit reports
  the matching text with whitespace collapsed and the line clipped at 400
  characters, and names the entry id that `lcm_expand_query` reads in full;
  `/lcm export` writes every character. The bounds stay separate and each is
  named in the output that hits it: the index reaches 100,000 characters, a
  pattern reads 200,000 per message and stops at one second, one grep line is 400
  characters, one reader window is 20,000 characters, and one call reads at most
  `max_tokens`.

## Documentation

|                                                                        |                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| [The docs site](https://stainless-code.com/lossless/)                  | How LCM behaves in a session, the config keys, the limits |
| [Comparison](https://stainless-code.com/lossless/reference/comparison) | The competing engines on one set of axes, verified cells  |
| [CHANGELOG.md](./CHANGELOG.md)                                         | Version history (changesets)                              |

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
