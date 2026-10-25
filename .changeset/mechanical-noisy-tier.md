---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
"deepseek-lossless": patch
---

Add a mechanical tier for noisy tools. Name tools in `mechanicalTools` in summarizer-config, `/lcm` config, or the OpenCode plugin options. Their spans compact into deterministic `mechanical` leaves with zero summarizer spend at compaction time. Every message stays stored verbatim and covered, so the integrity coverage check passes, and heal re-derives a skipped leaf from provenance on demand. There is no ingest filtering.
