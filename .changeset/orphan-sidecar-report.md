---
"deepseek-lossless": patch
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Report orphan sidecars in doctor. `integritySnapshot` now lists sidecar files and stale `wal` and `shm` files with no live session (`.sqlite` by default, `.db` for Pi). `checkIntegrity` reports them as a read-only `orphan-sidecar` finding through `lcm doctor` and the diagnose bundle. Report only. Deletion stays manual. Deepseek carries the finding through the diagnose bundle only, since it has no doctor verb.
