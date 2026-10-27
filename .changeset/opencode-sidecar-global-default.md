---
"opencode-lossless": patch
---

Change the default `sidecarDir` to the auto-detected global path. The plugin uses `XDG_DATA_HOME` with a `~/.local/share` fallback, uses `LOCALAPPDATA` with an `APPDATA` fallback and then a `<home>/AppData/Local` fallback on Windows, and uses `./.lossless` when no home resolves. To keep per-project storage, set `"sidecarDir": "./.lossless"`. After upgrading, run `/lossless-migrate` once per project that used `./.lossless`. The plugin never moves sidecars.
