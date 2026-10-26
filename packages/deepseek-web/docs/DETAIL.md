# Lossless presets for DeepSeek web

Four agent presets that mirror the shipped web presets with one change: the
compaction backend is the shared lossless core instead of the base backend.
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

Enable the host row first, in the profile user layer at
`~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- id: compaction-basic
  disabled: true
- id: deepseek-lossless
  config:
    enabled: true
```

Then select a Lossless preset for the session. A missing host core fails
fast naming the host row instead of running split-brain copies. To switch
back, select a shipped preset again; the base backend returns for those
sessions.
