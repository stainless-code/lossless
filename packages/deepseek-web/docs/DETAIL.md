# Lossless presets for DeepSeek web

Four agent presets that mirror the shipped web presets. The compaction
backend is the shared lossless core instead of the base backend, with
punctuation normalized and a preset description added.
Selecting one is the opt-in; the backend row ships enabled because the
selection itself is the opt-in.

## Install

Install alongside the host package on a preset-bearing profile (`web`,
`desktop`, or a custom profile built on `web-app`):

```sh
dsh plugin --profile web add deepseek-lossless
dsh plugin --profile web add deepseek-lossless-web
```

Host-plane profiles (`headless`, `acp`, `sdk`, custom base profiles) do not
need this package: the host switch from `deepseek-lossless` alone covers
them.

## Enable

No edits needed: the host bundle mounts its row enabled on install, so the
shared core is up once the profile restarts. Select a Lossless preset for
the session. A missing or disabled host row fails fast naming it instead of
running split-brain copies. To switch back, select a shipped preset again;
the base backend returns for those sessions.
