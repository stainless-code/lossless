---
"opencode-lossless": patch
---

Harden `lossless-gc` against deleting sidecars that are live in another process. Sweeps skip stores active within the last 60 minutes and name them. Bare `--older-than 0` without `--session` is refused. `--session` on a store active within 60 minutes needs `--force`. Candidates younger than 24 hours carry a warning.
