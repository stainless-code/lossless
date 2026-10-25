---
"pi-lossless": patch
"opencode-lossless": patch
---

Add a read-only static sidecar dump. `/lcm dump` and `/lossless-dump` open the session sidecar `queryOnly` and reuse the recall views and metric rows. The dump redacts displayed seams, labels removed rows, and reports old generations as named skips. Output is capped at 16 KB.
