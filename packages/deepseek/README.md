# deepseek-lossless

**Lossless Context Management (LCM) for the DeepSeek harness. Long sessions keep working past the point where the model would forget, and every verbatim message stays searchable and readable.**

Mount backfill mirrors at most 500 pre-mount events per session by default, while live events keep mirroring past the cap.

Apply it, and the adapter mirrors every session into its own SQLite sidecar.
The model reads that history back through `lcm_grep`, `lcm_describe`,
`lcm_expand`, and `lcm_expand_query`. The summarizer engine mounts as the
compaction backend: automatic pressure compaction stays off until `auto` opts
in, and `/lcm compact` runs one manual compaction through the DAG bracket.

This package is the DeepSeek adapter over
[`lossless-core`](https://npmx.dev/package/lossless-core), the engine that
ingests the history and builds the summaries.

## Pins

The adapter compiles against these exact published versions:

- `@deepseek-ai/dsh-agent@0.2.1-rc.3`
- `@deepseek-ai/dsh-commands@0.2.1-rc.3`
- `@deepseek-ai/dsh-compaction@0.2.1-rc.3`
- `@deepseek-ai/dsh-compaction-basic@0.2.1-rc.3`
- `@deepseek-ai/dsh-llm@0.2.1-rc.3`
- `@deepseek-ai/dsh-session@0.2.1-rc.3`
- `@deepseek-ai/dsh-session-projection@0.2.1-rc.3` (tests only)
- `@deepseek-ai/dsh-system-prompt@0.2.1-rc.3` (tests only)
- `@deepseek-ai/dsh-token-meter@0.2.1-rc.3` (tests only)
- `@deepseek-ai/dsh-tools@0.2.1-rc.3`
- `@deepseek-ai/cordis@4.0.5`

## Install

Opt-in per composition; nothing registers, mirrors, or mounts until `enabled`
is true:

```ts
import { applyLossless } from "deepseek-lossless";

const stop = applyLossless(ctx, { enabled: true });
```

## Config

| Key                       | Default                                        |
| ------------------------- | ---------------------------------------------- |
| `enabled`                 | unset (stays off)                              |
| `auto`                    | `false`                                        |
| `bracketAuto`             | `false`                                        |
| `sidecarDir`              | `./.lossless`                                  |
| `summaryTokens`           | `1500`                                         |
| `leafChunkTokens`         | `3000`                                         |
| `summarizationProvider`   | routed model                                   |
| `summarizationModel`      | routed model                                   |
| `thresholdRatio`          | `0.8`                                          |
| `retainTokens`            | unset                                          |
| `retainRatio`             | `0.16`                                         |
| `headroomTokens`          | `65536`                                        |
| `modelPolicies`           | unset                                          |
| `summarizerTokensPerCall` | `60000`                                        |
| `summarizerTokensPerPass` | `250000`                                       |
| `summarizerTokensPerHeal` | `120000`                                       |
| `healSourceTokens`        | `8` x `summaryTokens`, clamped `3000`..`24000` |

## `/lcm`

- `status`: session counts plus the meter window and last pass outcome.
- `report`: rolls up the metrics rows.
- `backup [file]`: writes a `0600` store copy.
- `export [file]`: writes a `0600` transcript copy.
- `import <file>`: dedups the named file.
- `gc [--apply]`: dry-runs age-based sidecar collection; `--apply` deletes.
- `migrate [--apply]`: lists older-schema sidecars; `--apply` migrates.
- `heal [--apply] [--max-nodes N]`: lists truncated summaries; `--apply` repairs.
- `diagnose [--save <file>]`: builds the redacted diagnose bundle.
- `compact`: one manual compaction.

## Tools

The model gets four recall tools:

- `lcm_grep`: full-text search over this session. `query` is an FTS5 search
  (words, quoted phrases, `AND`/`OR`, prefixes); `pattern` is a JavaScript
  regular expression over the full text of every message. `scope` reaches past
  sessions in the same sidecar directory (`sessions` and `all_sessions` are
  equivalent because the directory is global).
- `lcm_describe`: inspect one summary (kind, depth, costs, children, parents,
  full text) without expanding it.
- `lcm_expand`: read the verbatim originals a summary covers, or one message by
  `entry_id`. `session` reads a past session's sidecar read-only, labelled as a
  past session's history.
- `lcm_expand_query`: a bounded reader expands the stored originals and returns
  findings only, so the raw transcript never enters the context.

Full command, config, and file reference: [DeepSeek reference](https://stainless-code.com/lossless/reference/deepseek/tools).

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
