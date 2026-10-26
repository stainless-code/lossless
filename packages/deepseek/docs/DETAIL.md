# Lossless memory for DeepSeek

Long sessions keep working past the point where the model would forget. Aged turns become summary pointers the model can navigate, and every verbatim message stays in a local SQLite sidecar, searchable and readable in full.

## Install

Install is per profile. The host package covers host-plane profiles,
verified end to end: `headless`, `acp`, `sdk`, and custom profiles built
from the base bundle.

```sh
dsh plugin --profile headless add deepseek-lossless
```

For a custom profile, replace `headless` with its name. Without a shipped
template, the profile starts from the base bundle. Preset-bearing profiles
(`web`, `desktop`, or a custom profile built on `web-app`) need the preset
companion as well:

```sh
dsh plugin --profile web add deepseek-lossless
dsh plugin --profile web add deepseek-lossless-web
```

## Enable

No edits needed: installing the bundle switches the host-plane backend
over, since the shipped patch quiets the base row and mounts our row
enabled. The code-level default stays disabled, so direct composition
callers still opt in explicitly.

On a preset-bearing profile, install the companion, restart, then select a
Lossless preset for the session. The preset backend borrows the shared core
and fails fast naming the host row when it is absent.

Restart the profile, then verify with `/lcm status`. To switch back,
re-enable `compaction-basic` and disable `deepseek-lossless` from the
Plugins page or the profile patch; removing the bundle restores the base
row the same way.

## Configure

All options ride the plugin config. The Plugins page validates them against the bundled schema. Common keys:

- `auto`: automatic pressure compaction inside the turn.
- `sidecarDir`: one SQLite file per session. Defaults to `./.lossless`.
- `summaryTokens`, `leafChunkTokens`: summary budgets.
- `mechanicalTools`: tool names whose spans compact without a model call.

Reference holds the full surface: command, tools, config, and files.
