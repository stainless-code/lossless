# Headless e2e probes

Live harness probes for `deepseek-lossless`. These are manual recipes plus a
runner script, not unit tests: each probe boots a real `dsh` profile, calls a
real model over OpenRouter, and writes a real sidecar. Do not run them from the
repo root: run from `/tmp` so sidecar files land in `/tmp/.lossless` instead of
the repo (the headless sidecar directory defaults to `CWD/.lossless`).

## Scratch profiles

Two disposable profiles under `~/.dsh/profiles/`. Real profiles
(`web`, `desktop`, `headless`) stay untouched.

- `lossless-e2e`: base bundle plus the packed `deepseek-lossless` tarball,
  with the OpenRouter route and default model pinned to the free
  `cohere/north-mini-code:free` model in its `cordis.patch.yml`. Purpose: prove
  the shipped bundle answers headless tasks and mirrors messages to the
  sidecar.
- `lossless-plain`: base bundle only, same route and default model. Purpose:
  control profile that proves a hang or failure is environmental rather than
  caused by our bundle.

## Tarball rebuild

After changing the plugin, repack and reinstall into the scratch profile:

```sh
cd packages/deepseek && npm pack
cd ../deepseek-web && npm pack
dsh plugin --profile lossless-e2e add file:../deepseek/deepseek-lossless-0.1.0.tgz
```

## Probe 1: shipped headless profile plus model overlay

The shipped `headless` profile (base plus `@deepseek-ai/dsh-headless`
bundles) has the OpenRouter route but needs the default model pinned, so it
runs with the model overlay:

```sh
cd /tmp
DSH_PERMISSION_MODE=danger-full-access timeout 60 dsh --profile headless --patch ./overlays/model-overlay.yml --json "reply with exactly: pong" > /tmp/e2e-probe1.json
```

(Replace `./overlays/model-overlay.yml` with the path to
`packages/deepseek/test/e2e/overlays/model-overlay.yml` in this repo.)

## Probe 2: plain base plus headless overlay

The `lossless-plain` profile has no headless rows, so they are injected with
the headless overlay:

```sh
cd /tmp
DSH_PERMISSION_MODE=danger-full-access timeout 60 dsh --profile lossless-plain --patch ./overlays/headless-overlay.yml headless --json "reply with exactly: pong" > /tmp/e2e-probe2.json
```

## Probe 3: lossless bundle pong plus sidecar list

No overlay needed: `lossless-e2e` already carries the route, the default
model, and the bundle:

```sh
cd /tmp
DSH_PERMISSION_MODE=danger-full-access timeout 60 dsh --profile lossless-e2e headless --json "reply with exactly: pong" > /tmp/e2e-lossless.json
ls /tmp/.lossless/*.sqlite
```

## Expected pong output shape

With `--json`, stdout is newline-delimited run events. A passing run ends with
the final event on the last line:

```json
{ "type": "final", "text": "pong" }
```

Without `--json`, stdout is just `pong` and diagnostics go to stderr. Any
timeout (exit 124), empty output, or missing final event is a failure. Known
history: on 2026-10-27 these same commands hung with zero output and no
sidecar writes even without our bundle, which pointed at the environment
(free-tier queue, approval gate, or session startup) rather than the plugin,
because raw `curl` to the same OpenRouter model answered in about one second.

## Sidecar check paths

After a passing probe 3, these exist:

- `/tmp/.lossless/*.sqlite` (one per headless session)
- `/tmp/.lossless/metrics.jsonl`

## Recall note

The `/lcm` slash commands exist only in TUI and Web sessions. Typing `/lcm
status` into a headless shell just fails with `/lcm: No such file or
directory` (see the `e2e-lcm-status` probe pattern). In headless runs, recall
goes through the `lcm_grep` family of tools instead: resume the earlier
session with `--session-id <id>` and ask the model to search with `lcm_grep`,
which returns matches like `Found 4 match(es)` followed by the answer.

## Free model fallback order

If the pinned model stalls or rate-limits, try the next model in this order
(copied from `~/.dsh/profiles/desktop/cordis.patch.yml`, probed working
2026-10-25):

1. `cohere/north-mini-code:free`
2. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
3. `nvidia/nemotron-3-ultra-550b-a55b:free`
4. `poolside/laguna-s-2.1:free`
5. `xingchen-agi/xing4.0-29b-a4b:free`

Swap the model id in `overlays/model-overlay.yml` (or the scratch profile
patch) and rerun the probe.

## Runner script

`run-e2e.sh` executes probes 1 to 3 in order with `timeout 60` guards,
asserts the pong final event in each output file, and lists the sidecar
files. It takes no arguments and stops nonzero on the first failure:

```sh
./packages/deepseek/test/e2e/run-e2e.sh
```
