# `deepseek-lossless` (working name)

Lossless Context Management for the DeepSeek harness, built on `lossless-core`.
Status: evaluation spike on a branch. It implements the plan in
`docs/deepseek-plan.md` phase by phase, and `docs/roadmap.md` item 10
tracks this work until the live-proof gate is met.

## Pins

The adapter compiles against these exact published versions, which match the
pinned local checkout (release `dsh-0.1.7-alpha.2`, vendor `4.0.4`):

- `@deepseek-ai/dsh-agent@0.1.7-alpha.2`
- `@deepseek-ai/dsh-commands@0.1.7-alpha.2`
- `@deepseek-ai/dsh-compaction@0.1.7-alpha.2`
- `@deepseek-ai/dsh-compaction-basic@0.1.7-alpha.2`
- `@deepseek-ai/dsh-llm@0.1.7-alpha.2`
- `@deepseek-ai/dsh-session@0.1.7-alpha.2`
- `@deepseek-ai/dsh-session-projection@0.1.7-alpha.2` (tests only)
- `@deepseek-ai/dsh-system-prompt@0.1.7-alpha.2` (tests only)
- `@deepseek-ai/dsh-token-meter@0.1.7-alpha.2` (tests only)
- `@deepseek-ai/dsh-tools@0.1.7-alpha.2`
- `@deepseek-ai/cordis@4.0.4`

The checkout lives outside this repo and is never vendored here. Every phase
log names the commit it ran against, because the harness warns of breaking
changes.
