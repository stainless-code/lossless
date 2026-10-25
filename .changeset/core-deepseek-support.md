---
"lossless-core": patch
---

Support the DeepSeek adapter from core. `readMetricRows` takes `session` and `limit` filters, the metrics sink adds usage-tally helpers, `SidecarStores` evicts closed handles, `token-window` selects the compactable range, and `toolNameOfText` is exported for scope matching.
