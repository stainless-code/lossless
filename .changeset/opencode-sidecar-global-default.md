---
"opencode-lossless": patch
---

Change the default `sidecarDir` to the auto-detected global path. The plugin uses `XDG_DATA_HOME` with a `~/.local/share` fallback, uses `LOCALAPPDATA` with an `APPDATA` fallback and then a `<home>/AppData/Local` fallback on Windows, and uses `./.lossless` when no home resolves. To keep per-project storage, set `"sidecarDir": "./.lossless"`. After upgrading a project that used `./.lossless`, keep that setting to keep its history: `/lossless-migrate` upgrades in place in the configured directory only (dry run by default) and moves nothing, so it cannot recover history left in `./.lossless`. To carry history across, export per session under the old config and import into an empty store under the new one, or stop the server first and copy the `.sqlite`, `-wal`, and `-shm` files across and then migrate. The plugin never moves sidecars.
