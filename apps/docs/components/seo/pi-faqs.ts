import { SHARED_FAQS } from "./lcm-faqs.ts";
import type { LcmFaq } from "./lcm-faqs.ts";

/** Questions that are specific to the Pi extension. */
export const PI_FAQS: readonly LcmFaq[] = [
  {
    question: "Does it modify my Pi session file?",
    answer:
      "No. Pi's session record stays the source of truth; `pi-lossless` mirrors into a sidecar it owns under `~/.pi/agent/lcm/`. Deleting the sidecar does not edit the session, but it does forget that session's recall.",
  },
  SHARED_FAQS.lossy,
  {
    question: "Do I have to configure anything?",
    answer:
      "No. Passive logging and the defaults (swap at 70% of the model window, keep 20,000 tokens verbatim) work with no config. The optional file is `~/.pi/agent/lcm.json`; `/lcm settings` edits the live session, and you save those values to the file to keep them.",
  },
  {
    question: "Where does the data live?",
    answer:
      "One SQLite store per session under `~/.pi/agent/lcm/`. The directory is mode 0700; the database, WAL, and shared-memory files are 0600. Metrics sit beside the stores. Nothing leaves the machine except the provider calls the summarizer and reader make.",
  },
  {
    question: "Does it replace Pi's compaction?",
    answer:
      "It replaces the aged prefix Pi sends to the model with a pinned summary frontier, so the model sees less. The session record is untouched. Set `assemblyEnabled: false` to keep ingestion, recall, and metrics while leaving compaction to Pi.",
  },
  {
    question: "Can the model read a past Pi session?",
    answer:
      'Yes, when it asks. `lcm_grep` with `scope: "sessions"` searches this project\'s past sessions, and `"all_sessions"` searches every project. Hits are pointers; nothing from a past session is injected automatically.',
  },
  SHARED_FAQS.caching,
  {
    question: "What commands does it add?",
    answer:
      "`/lcm status`, `/lcm report`, `/lcm doctor`, `/lcm settings`, `/lcm backup`, `/lcm export`, `/lcm import`, `/lcm gc`, `/lcm migrate`, and `/lcm diagnose`. The [command reference](/reference/pi/command) documents each one, and the [tool reference](/reference/pi/tools) covers the recall tools.",
  },
  SHARED_FAQS.secrets,
  {
    question: "How do I remove it?",
    answer:
      "Uninstall the extension and delete `~/.pi/agent/lcm/`. Before deleting, `/lcm backup` keeps a byte copy and `/lcm export` writes a portable JSONL transcript. `/lcm gc` lists stores whose session file is gone; `--apply` exports them before deleting.",
  },
];
