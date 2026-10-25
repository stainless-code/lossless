---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Report orphan sidecars in doctor. `integritySnapshot` now lists `.sqlite` files and stale `wal` and `shm` files with no live session. `checkIntegrity` reports them as a read-only `orphan-sidecar` finding through `lcm doctor` and the diagnose bundle. Report only. Deletion stays manual.
