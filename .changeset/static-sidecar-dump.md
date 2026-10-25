---
"pi-lossless": patch
"opencode-lossless": patch
"deepseek-lossless": patch
---

Add a read-only static sidecar dump. `/lcm dump` (plus `/lossless-dump` on Pi and OpenCode) opens the session sidecar `queryOnly` and reuses the recall views and metric rows. The dump redacts displayed seams, labels removed rows, and reports old generations as named skips. Output is capped at 16 KB.
