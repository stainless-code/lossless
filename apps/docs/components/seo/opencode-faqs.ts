import { SHARED_FAQS } from "./lcm-faqs.ts";
import type { LcmFaq } from "./lcm-faqs.ts";

/** Questions that are specific to the OpenCode v2 plugin. */
export const OPENCODE_FAQS: readonly LcmFaq[] = [
  {
    question: "Does it modify my OpenCode session record?",
    answer:
      "No. OpenCode's session record stays the source of truth; the plugin mirrors into a per-session SQLite sidecar under `sidecarDir`. Deleting a sidecar does not edit the session, and the adapter does not backfill it.",
  },
  SHARED_FAQS.lossy,
  {
    question: "Do I have to configure anything?",
    answer:
      "No. The defaults (swap at 70%, re-cut at 85%, keep 20,000 tokens verbatim) work with no options. Configuration is the plugin's `options` in `opencode.json`; there is no separate config file or interactive settings panel. `sidecarDir` defaults to `./.lossless`, resolved from the server working directory.",
  },
  {
    question: "Where does the data live?",
    answer:
      "One SQLite sidecar per session under `sidecarDir` (default `./.lossless`, resolved from the OpenCode server working directory). The directory is 0700; the database, WAL, and shared-memory files are 0600. Nothing leaves the machine except the provider calls the summarizer and reader make.",
  },
  {
    question: "Does it replace OpenCode compaction?",
    answer:
      "It builds the DAG, replaces aged history in `session.context` with the summary frontier, and returns the same frontier as the host compaction checkpoint. `assembly: false` keeps the mirror and recall tools and leaves compaction to OpenCode.",
  },
  {
    question: "Which OpenCode version does it support?",
    answer:
      "It targets the OpenCode v2 plugin API and is verified against OpenCode v2.1.3. The package needs Node.js 22.19 or newer.",
  },
  {
    question: "Can the model read a past OpenCode session?",
    answer:
      'Yes. `lcm_grep` scans the global sidecar directory, so `"sessions"` and `"all_sessions"` are equivalent today. The reader runs in a child session limited to the recall tools, and its transcript sidecar is removed after it answers.',
  },
  SHARED_FAQS.caching,
  {
    question: "What commands and tools does it add?",
    answer:
      "Commands: `/lossless-status`, `/lossless-report`, `/lossless-pass`, `/lossless-backup`, `/lossless-export`, `/lossless-import`, `/lossless-gc`, `/lossless-migrate`, `/lossless-diagnose`. Tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`. The [command reference](/reference/opencode/command) and [tool reference](/reference/opencode/tools) document each one.",
  },
  SHARED_FAQS.secrets,
  {
    question: "How do I remove it?",
    answer:
      "Run `opencode plugin remove opencode-lossless` and delete the configured `sidecarDir`. `/lossless-backup` copies a sidecar, `/lossless-export` writes a JSONL transcript, and `/lossless-gc --older-than 30 --apply` exports and deletes old sidecars without touching the current one.",
  },
];
