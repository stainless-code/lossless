# pi-lossless

## 0.1.1

### Patch Changes

- 6748df1: Refresh every external dependency to its newest published version: Vite+ 1.4.0 and Vitest 5.0.5, TypeScript 7.0.2, `@types/node` 26.6.5, `@changesets/cli` 3.0.3, Pi 1.4.0, OpenCode 2.1.4, Typebox 1.4.3, Blume 2.2.5, and Bun 1.4.4. Pi host packages now use the `*` peer range its package guide documents for packages the host supplies.
- 6748df1: Derive the heal source window from the summary target instead of clipping every source message at a fixed 3,000 tokens. The window is clamped to the summarizer request budget and has an explicit `healSourceTokens` override in Pi and OpenCode. A leaf that exceeds one window is mapped through up to eight exact windows and reduced once, so a large tool result can become clean without one enormous prompt. A source beyond the bounded plan is blocked without another model call, while a mechanical node gets one improvement. Heal reports now separate clean repairs from improvements and record source-blocked nodes.
- 6748df1: Add per-node summary timing, session-correlated engine rows, and adapter-routed metrics. OpenCode now writes engine and summarizer rows to its sidecar log, exposes the summarizer call and pass budgets, marks character-derived usage as estimated, and reports summary latency, cap outcomes, and abandoned rows. Add persistent summary quality: clean, clipped, mechanical, and derived. Existing stores migrate to generation 2, and a failed parent stays visible as derived. Add a bounded heal command in both adapters. It finds tainted summaries and their ancestors, re-derives them from stored source bottom-up, rejects another mechanical result, and supports a dry run. A heal owns its store connection so a plugin reload cannot finalize it, and one session allows one heal at a time. Mechanical work runs before a clipped retry, so a bounded run keeps making progress.

## 0.1.0

First release.
