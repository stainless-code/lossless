---
"lossless-core": patch
---

Add a mechanical tier for noisy tools. Name tools in `mechanicalTools` (summarizer-config) and their spans compact into deterministic `mechanical` leaves with zero summarizer spend at compaction time. Every message stays stored verbatim and covered, so the integrity coverage check passes, and heal re-derives a skipped leaf from provenance on demand. No ingest filtering.
