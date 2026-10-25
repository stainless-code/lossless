---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Recall search upgrades: `lcm_grep` takes `role`, `date_start`/`date_end`, and `tool_name` filters (role and time are SQL predicates on the stored columns with a covering index, tool scope is an FTS rewrite against `[tool:Name]` markers with no new table or index); `lcm_expand` takes an `anchor` entry id that centers the listing window with edge clamping; the recall manifest and retrieval brief order by stop-word stripped query-word overlap over summary headers; and a read-only files view lists each linked file once with an incomplete-coverage flag and a `large-inline` mark. No migration and no new writer.
