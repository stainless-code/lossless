---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Verify file bytes and sha256 against the linked message text before inserting file rows on import. A repeated entry id with different text, or a file row whose text differs from the stored message, also refuses the import without writing. Existing rows stay untouched.
