# deepseek-lossless-web

Lossless presets for the DeepSeek web surface: Lossless variants of all four
shipped agent presets (`standard`, `ptc`, `minimal`, `cordis`) whose
compaction backend runs the shared lossless core. Preset sessions keep their
catalog; only the backend is swapped.

## Install

Install alongside `deepseek-lossless` on a preset-bearing profile (`web`,
`desktop`, or a custom profile built on `web-app`):

```sh
dsh plugin --profile web add deepseek-lossless
dsh plugin --profile web add deepseek-lossless-web
```

Host-plane profiles (`headless`, `acp`, `sdk`, custom base profiles) do not
need this package: the host switch from `deepseek-lossless` alone covers
them.

## Use

Restart the profile, then select a Lossless preset for the session. The
preset backend borrows the shared host core and fails fast naming the host
row when it is absent. To switch back, select a shipped preset again.

## Pins

The four presets are byte-for-byte copies of the harness presets at
dsh v0.2.1-rc.3 (the version our peers admit) except the backend row, plus a
punctuation normalization the repo requires. Re-sync them when the peer
floor moves: diff each file against the new harness preset and carry over
everything except the backend row.

## License

MIT, see [LICENSE](./LICENSE).
