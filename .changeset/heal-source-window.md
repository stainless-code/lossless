---
"lossless-core": patch
"pi-lossless": patch
"opencode-lossless": patch
---

Derive the heal source window from the summary target instead of clipping every source message at a fixed 3,000 tokens. The window is clamped to the summarizer request budget and has an explicit `healSourceTokens` override in Pi and OpenCode. A leaf that exceeds one window is mapped through up to eight exact windows and reduced once, so a large tool result can become clean without one enormous prompt. A source beyond the bounded plan is blocked without another model call, while a mechanical node gets one improvement. Heal reports now separate clean repairs from improvements and record source-blocked nodes.
