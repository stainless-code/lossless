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

/**
 * Answers that do not change between harnesses. The host-specific pages spread
 * these into their own lists so a behavior change is edited once.
 */
export const SHARED_FAQS = {
  lossy: {
    question: "Is it lossy?",
    answer:
      "The projection is lossy by construction, because the model sees a smaller view. The store is not. The store holds every message whole, and `lcm_expand_query` reads the stored bytes back by address.",
  },
  caching: {
    question: "Does it break provider prompt caching?",
    answer:
      "The projection is pinned and byte-identical between cuts, so the cached prefix survives until a recut. A recut changes the prefix.",
  },
  secrets: {
    question: "What happens to secrets in the store?",
    answer:
      "Stores are plaintext and hold the session verbatim, secrets included. Redaction is best-effort masking on the way out to a model, not a security boundary. See [Security](/concepts/security).",
  },
} satisfies Record<string, LcmFaq>;

/**
 * The unlocked fallback FAQ. Host pages use the tailored lists in
 * `pi-faqs.ts` and `opencode-faqs.ts`.
 */
export const LCM_FAQS: readonly LcmFaq[] = [
  {
    question: "Does it modify my session file?",
    answer:
      "No. The harness's session record stays the source of truth; the adapter mirrors into a sidecar it owns. Deleting the sidecar does not edit the session. Pi keeps sidecars under `~/.pi/agent/lcm/`; OpenCode uses the configured `sidecarDir`.",
  },
  SHARED_FAQS.lossy,
  {
    question: "Which harnesses does it support?",
    answer:
      "Pi and OpenCode v2 today. The engine is shared (`lossless-core`); each harness has its own adapter (`pi-lossless`, `opencode-lossless`). Another harness means another adapter, not a second engine. See [The engine and its adapters](/concepts/engine-and-harness).",
  },
  {
    question: "Do I have to configure anything?",
    answer:
      "No. Passive logging and the defaults (swap at 70% of the model window, keep 20,000 tokens verbatim) work with no config. Pi reads `~/.pi/agent/lcm.json`; OpenCode reads the plugin's `options` in `opencode.json`. Both are optional.",
  },
  {
    question: "Where does the data live?",
    answer:
      "One SQLite file per session in the adapter's sidecar directory. Pi uses `~/.pi/agent/lcm/`. OpenCode uses the configured `sidecarDir`. The default is a global auto-detected path. [Config](/reference/opencode/config) lists the exact paths. The directory is 0700. The database, WAL, and shared-memory files are 0600. Metrics files are beside the stores. Nothing leaves the machine except the provider calls the summarizer and reader make.",
  },
  SHARED_FAQS.caching,
  {
    question: "Can the model read a session that is already over?",
    answer:
      'Yes, when it asks. Pi: `lcm_grep` with `scope: "sessions"` searches this project\'s past sessions, and `"all_sessions"` searches every project. OpenCode: the same tool scans the global sidecar directory, so both scopes are equivalent today. Hits are pointers; nothing from a past session is injected automatically.',
  },
  SHARED_FAQS.secrets,
  {
    question: "How do I get rid of it?",
    answer:
      "Remove the adapter or plugin and delete its sidecar directory. Pi: uninstall `pi-lossless`, delete `~/.pi/agent/lcm/`; `/lcm gc` lists retired stores, and `--apply` exports them before deleting. OpenCode: `opencode plugin remove opencode-lossless`, then delete the configured `sidecarDir`; deleting a sidecar forgets that session.",
  },
];
