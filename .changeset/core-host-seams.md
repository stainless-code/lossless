---
"lossless-core": patch
---

Add the three host seams the OpenCode adapter uses: `renderableFrontier` renders a store's DAG frontier for a host checkpoint, `grepView` accepts an `expandTool` name so each adapter can name its own expansion tool, and `LcmStore.entryCountWithPrefix` counts a family of rows without a table scan.
