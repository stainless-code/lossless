---
"pi-lossless": patch
"opencode-lossless": patch
---

Add a read-only static sidecar dump. `/lcm dump` and `/lossless-dump` open the session sidecar `queryOnly`, reuse the recall views plus metric rows, redact displayed seams, label removed rows, and report old generations as named skips. Output is capped at 16 KB.
