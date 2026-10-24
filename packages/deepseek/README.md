# `deepseek-lossless` (working name)

Lossless Context Management for the DeepSeek harness, built on `lossless-core`.
Status: evaluation spike on a branch. It implements the plan in
`docs/deepseek-plan.md` phase by phase, and `docs/roadmap.md` item 10
tracks this work until the live-proof gate is met.

## Pins

The adapter compiles against these exact published versions, which match the
pinned local checkout at `22ddee3792`:

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

The checkout lives outside this repo and is never vendored here. Every phase
log names the commit it ran against, because the harness warns of breaking
changes.

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
- `report`: rolls up the metrics rows in the OpenCode vocabulary.
- `backup [file]`: writes a `0600` store copy.
- `export [file]`: writes a `0600` transcript copy.
- `import <file>`: dedups the named file through `importTranscript`.
- `gc [--apply]`: dry-runs age-based sidecar collection; `--apply` deletes.
- `migrate [--apply]`: dry-runs the generation gate; `--apply` migrates.
- `heal [--apply] [--max-nodes N]`: dry-runs core `runHeal`; `--apply` repairs.
- `diagnose [--save <file>]`: builds the redacted core bundle.
- `compact`: one manual compaction through the DAG bracket.
