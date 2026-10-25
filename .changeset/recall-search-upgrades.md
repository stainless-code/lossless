---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
"deepseek-lossless": patch
---

Upgrade recall search. `lcm_grep` takes `role`, `date_start`/`date_end`, and `tool_name` filters. Role and time are SQL predicates on the stored columns with a covering index. Tool scope is an FTS rewrite against `[tool:Name]` markers with no new table or index. `lcm_expand` takes an `anchor` entry id that centers the listing window with edge clamping. The recall manifest and the retrieval brief order by stop-word stripped query-word overlap over summary headers. A read-only files view lists each linked file once with an incomplete-coverage flag and a `large-inline` mark. No migration and no new writer.
