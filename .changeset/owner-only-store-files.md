---
"lossless-core": patch
---

Create store files owner-only before SQLite opens them, so the database, WAL, and shared-memory files are 0600 from the first write, and repair an existing world-readable database on open.
