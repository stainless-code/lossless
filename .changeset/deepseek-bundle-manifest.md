---
"deepseek-lossless": patch
---

Ship the profile bundle. The package declares `dsh.bundle`, ships its patch layer, icon, locale metadata, and detail doc, and exposes the Cordis plugin shape (`name`, `inject`, `Config`, `apply`) so `dsh plugin --profile <name> add deepseek-lossless` installs as a profile layer instead of a plain dependency. Install stays per profile; the guide covers `web`, `headless`, and custom names plus the enable step that replaces the base compaction backend.
