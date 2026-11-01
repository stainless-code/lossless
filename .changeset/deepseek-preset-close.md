---
"deepseek-lossless": patch
"deepseek-lossless-web": patch
---

Fix preset teardown leaking open SQLite handles: whichever disposer releases the last core ownership (host or preset) now runs the shared guarded close, so idle stores always close on final release instead of only when the host happens to stop last. Also corrects the uninstall answer to lead with `dsh plugin remove` plus restart, since the shipped bundle patch owns the enable/disable rows and fresh installs create no user rows to delete.
