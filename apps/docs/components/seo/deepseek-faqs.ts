import { SHARED_FAQS } from "./lcm-faqs.ts";
import type { LcmFaq } from "./lcm-faqs.ts";

/** Questions that are specific to the DeepSeek bundle. */
export const DEEPSEEK_FAQS: readonly LcmFaq[] = [
  {
    question: "Does it modify my DeepSeek session record?",
    answer:
      "No. The harness session record stays the source of truth; the adapter mirrors into a per-session SQLite sidecar under the configured `sidecarDir` (default `./.lossless`). Deleting a sidecar does not edit the session, but it does forget that session's recall.",
  },
  SHARED_FAQS.lossy,
  {
    question: "Do I have to configure anything?",
    answer:
      "Install into each profile you boot, then enable the row. The defaults (pressure at 80% of the priced window, keep 16% verbatim, summary and leaf budgets of 1500 and 3000 tokens) work with no further options. Configuration is the `deepseek-lossless` row in the profile patch; there is no separate config file. The [configuration guide](/guides/deepseek/configuration) lists every key.",
  },
  {
    question: "Where does the data live?",
    answer:
      "One SQLite sidecar per session under `sidecarDir` (default `./.lossless`). The directory is 0700; the database, WAL, and shared-memory files are 0600. Metrics sit beside the stores. Nothing leaves the machine except the provider calls the summarizer and reader make.",
  },
  {
    question: "Does it replace DeepSeek compaction?",
    answer:
      "It mounts as the profile compaction backend once the base `compaction-basic` row is disabled and the bundle row is enabled. Aged turns become summary pointers the model can navigate, and the engine returns the same frontier as the host compaction checkpoint.",
  },
  {
    question: "Can the model read a past DeepSeek session?",
    answer:
      'Yes. `lcm_grep` scans the global sidecar directory, so `"sessions"` and `"all_sessions"` are equivalent today. Hits are pointers; nothing from a past session is injected automatically.',
  },
  SHARED_FAQS.caching,
  {
    question: "What commands and tools does it add?",
    answer:
      "The `/lcm` verbs `status`, `report`, `dump`, `backup`, `export`, `import`, `gc`, `migrate`, `heal`, `diagnose`, and `compact`. Tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, and `lcm_expand_query`. The [command reference](/reference/deepseek/command) and [tool reference](/reference/deepseek/tools) document each one.",
  },
  SHARED_FAQS.secrets,
  {
    question: "How do I remove it?",
    answer:
      "Remove both rows from the profile patch and restart to switch back to the base backend, then run `dsh plugin --profile <name> remove deepseek-lossless` and delete the configured `sidecarDir`. `/lcm backup` copies a sidecar, `/lcm export` writes a JSONL transcript, and `/lcm gc --apply` exports and deletes retired sidecars.",
  },
];
