/**
 *
 * `answer` is a small subset of Markdown: backticked code and `[label](href)`
 * links, which `FaqSection.astro` renders into HTML and flattens for the
 * JSON-LD answer text.
 */
export interface LcmFaq {
  question: string;
  answer: string;
}

export const LCM_FAQS: readonly LcmFaq[] = [
  {
    question: "Does it modify my session file?",
    answer:
      "No. Pi's session file stays the source of truth and the store is a derived index. Delete `~/.pi/agent/lcm/` and restart to rebuild it from the session file.",
  },
  {
    question: "Is it lossy?",
    answer:
      "Summaries are lossy by construction, because the model sees a smaller projection. The store is not lossy. Every message is held whole, and `lcm_expand_query` reads the stored bytes back by address.",
  },
  {
    question: "Does it only work with Pi?",
    answer:
      "Pi is the harness it runs in today, and `pi-lossless` is the adapter that installs into it. The engine ships separately as `lossless-core` and names no agent SDK, so the store, the DAG, and the recall tools do not change with the harness. A second harness means a second adapter. See [The engine and its harness](/concepts/engine-and-harness).",
  },
  {
    question: "Do I have to configure anything?",
    answer:
      "No. Passive logging starts on the first turn and swaps begin at 70% of the model's context window. `~/.pi/agent/lcm.json` is optional and every key in it has a default.",
  },
  {
    question: "Where does the data live?",
    answer:
      "One SQLite file per session under `~/.pi/agent/lcm/`, mode 0600, named by a hash of the session file path. Metrics go to `~/.pi/agent/lcm/metrics.jsonl`. Nothing leaves the machine except the model calls this package makes through your provider: the summarizer passes and the reader behind `lcm_expand_query`, which runs on the session model.",
  },
  {
    question: "Does it break provider prompt caching?",
    answer:
      "Swaps are commit-batched and the projection stays byte-identical between them, so the cached prefix survives until the recut line. Past that line, one re-cut replaces the projection with a smaller shape.",
  },
  {
    question: "Can the model read a session that is already over?",
    answer:
      'Yes, and only when it asks. `lcm_grep` with `scope: "sessions"` searches this project\'s past sessions and `"all_sessions"` searches every project, returning pointers rather than text. Nothing from a past session is injected into the current one.',
  },
  {
    question: "What happens to secrets in the store?",
    answer:
      "Stores are plaintext and hold the session verbatim, secrets included. Redaction is best-effort masking on the way out to a model, not a security boundary. See [Security](/concepts/security).",
  },
  {
    question: "How do I get rid of it?",
    answer:
      "Uninstall the extension and delete `~/.pi/agent/lcm/`. `/lcm gc` lists retired stores, and `--apply` exports them before deleting. `/lcm export` writes the full verbatim transcript first.",
  },
] as const;
