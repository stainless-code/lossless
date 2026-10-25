---
"pi-lossless": patch
"lossless-core": patch
---

Signal a watermark miss on the ingest path: a full rescan now writes one `ingest-rescan` metric row and, in interactive sessions, one UI warning. Empty entries stay silent and ingest behavior is unchanged.
