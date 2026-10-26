---
"deepseek-lossless": patch
"deepseek-lossless-web": patch
---

Support every DSH surface. The host composition now runs on a shared core so a preset-realm backend entrypoint (`deepseek-lossless/preset`) can mount the compaction engine inside agent presets without mirroring twice or closing shared handles; it fails fast naming the host row when the core is absent. The new `deepseek-lossless-web` companion bundle ships Lossless variants of all four shipped presets with only the backend row swapped, pinned to the same harness version as the peers. Web and desktop sessions select a Lossless preset; headless, acp, sdk, and custom base profiles keep the host switch alone.
