---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Verify file bytes and sha256 against the linked message text before inserting file rows on import. A mismatch refuses the import without writing, leaving existing rows untouched.
