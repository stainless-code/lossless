---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Ask providers for a whole number of tokens. A leaf target was half of the calibrated chunk budget, so it was fractional whenever that budget was odd, and a provider that validates `max_tokens` as an unsigned integer rejected the call with a 422. The ladder then stored the deterministic truncate: in one week of Pi sessions that was 1,315 of 5,358 summaries, with 540 rejected calls naming values such as `max_tokens: 5543.5`. The request builder now rounds to nearest, never below one, and treats a non-finite budget as that floor, before the reasoning headroom is added. Integer budgets produce the same request as before. No config key, migration or metric row changes.
