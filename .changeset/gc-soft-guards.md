---
"opencode-lossless": patch
---

Harden `lossless-gc` against deleting sidecars that are live in another process. Sweeps skip stores active within the last 60 minutes and name them, bare `--older-than 0` without `--session` is refused, `--session` on a recently active store needs `--force`, and candidates younger than 24 hours carry a warning.
