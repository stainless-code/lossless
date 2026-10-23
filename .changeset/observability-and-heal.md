---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Add per-node summary timing, session-correlated engine rows, and adapter-routed metrics. OpenCode now writes engine and summarizer rows to its sidecar log, exposes the summarizer call and pass budgets, marks character-derived usage as estimated, and reports summary latency, cap outcomes, and abandoned rows. Add persistent summary quality: clean, clipped, mechanical, and derived. Existing stores migrate to generation 2, and a failed parent stays visible as derived. Add a bounded heal command in both adapters. It finds tainted summaries and their ancestors, re-derives them from stored source bottom-up, rejects another mechanical result, and supports a dry run.
