/** Cross-session recall over the sidecar directory. OpenCode keeps one global
 * sidecar directory, so "past sessions in this project" has no index here: the
 * two scopes scan the same files, and this module says so rather than inventing
 * a project boundary. A hit is a labelled pointer, never text folded into the
 * caller's history, and the past store is opened with `queryOnly` so a scan can
 * never rewrite a session it is only reading.
 *
 * The scan is capped three ways, because an unbounded directory read inside a
 * tool call is a latency bug: 20 stores, 40 hits, and 1.5 s. Whichever cap
 * stops the scan is named in the answer, so "no match" never silently means
 * "stopped early". */

import { LcmStore, grepView } from "lossless-core";

import type { SidecarRef } from "./sidecars.ts";

export const CROSS_SESSION_STORE_LIMIT = 20;
export const CROSS_SESSION_HITS_LIMIT = 40;
export const CROSS_SESSION_DEADLINE_MS = 1_500;
/** Hits one past session may contribute. A single chatty store must not fill
 * the whole page while newer stores go unread. */
export const CROSS_SESSION_PER_STORE_HITS = 10;

/** The sidecars past sessions are read from. `list` excludes the calling
 * session, so no scope can reach the store a normal grep already searched. */
export interface PastSessions {
  list(excludeSessionId: string | undefined): readonly SidecarRef[];
}

export interface PastSearchDeps {
  readonly past: PastSessions;
  readonly redact: (text: string) => string;
  /** Injected clock, so the deadline is testable. */
  readonly now?: () => number;
}

export type PastSearchStop = "stores" | "hits" | "deadline";

export interface PastSearchResult {
  readonly text: string;
  readonly hits: number;
  readonly scanned: number;
  readonly skipped: number;
  readonly sessions: number;
  readonly elapsedMs: number;
  readonly stoppedBy?: PastSearchStop;
}

/** Search every past sidecar for `query` and format the labelled hits. A store
 * that cannot be opened is counted and skipped: an older generation or a file
 * in use is not an error the caller can act on mid-turn. */
export function searchPastSessions(
  deps: PastSearchDeps,
  callingSessionId: string | undefined,
  query: string,
  opts: { limit?: number; now?: () => number } = {},
): PastSearchResult {
  const now = opts.now ?? deps.now ?? Date.now;
  const started = now();
  const hitLimit = clampLimit(opts.limit, CROSS_SESSION_HITS_LIMIT);
  const deadline = started + CROSS_SESSION_DEADLINE_MS;
  const all = deps.past.list(callingSessionId);
  const refs = all.slice(0, CROSS_SESSION_STORE_LIMIT);

  const lines: string[] = [];
  const sessions = new Set<string>();
  let hits = 0;
  let scanned = 0;
  let skipped = 0;
  let stoppedBy: PastSearchStop | undefined = all.length > refs.length ? "stores" : undefined;

  for (const ref of refs) {
    if (hits >= hitLimit) {
      stoppedBy = "hits";
      break;
    }
    if (now() > deadline) {
      stoppedBy = "deadline";
      break;
    }
    let store: LcmStore | undefined;
    try {
      store = new LcmStore(ref.path, { queryOnly: true });
    } catch {
      skipped++;
      continue;
    }
    try {
      const view = grepView(store, deps.redact, {
        query,
        limit: Math.min(CROSS_SESSION_PER_STORE_HITS, hitLimit - hits),
        expandTool: "lcm_expand",
      });
      if (!view.ok) {
        // A query this store rejects was rejected by every store; report the
        // view's own message rather than a fake "no matches".
        return finish(view.text, {
          hits: 0,
          scanned,
          skipped,
          sessions: 0,
          started,
          now,
          stoppedBy,
        });
      }
      scanned++;
      for (const line of view.text.split("\n")) {
        if (!line.startsWith("[")) continue;
        if (hits >= hitLimit) break;
        lines.push(`[lcm:session ${ref.id}] ${line}`);
        hits++;
        sessions.add(ref.id);
      }
    } catch {
      skipped++;
    } finally {
      store.close();
    }
  }

  if (hits >= hitLimit && stoppedBy === undefined) stoppedBy = "hits";
  const body =
    hits === 0
      ? `No matches in ${scanned} past session(s)${skippedNote(skipped)}.`
      : [
          `Found ${hits} match(es) across ${sessions.size} past session(s) in ${now() - started} ms (scanned ${scanned}${skippedNote(skipped)}).`,
          ...lines,
          "Read a hit with lcm_expand({session, entry_id}); the text it returns is that past session's history, never this one's.",
        ].join("\n");
  const stopped = stopNote(stoppedBy);
  return finish(stopped === undefined ? body : `${body}\n${stopped}`, {
    hits,
    scanned,
    skipped,
    sessions: sessions.size,
    started,
    now,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  });
}

function finish(
  text: string,
  state: {
    hits: number;
    scanned: number;
    skipped: number;
    sessions: number;
    started: number;
    now: () => number;
    stoppedBy?: PastSearchStop;
  },
): PastSearchResult {
  return {
    text,
    hits: state.hits,
    scanned: state.scanned,
    skipped: state.skipped,
    sessions: state.sessions,
    elapsedMs: state.now() - state.started,
    ...(state.stoppedBy === undefined ? {} : { stoppedBy: state.stoppedBy }),
  };
}

function skippedNote(skipped: number): string {
  return skipped === 0 ? "" : `, skipped ${skipped} unreadable`;
}

/** The cap that ended the scan, named so a short answer is not read as a
 * complete one. */
export function stopNote(stoppedBy: PastSearchStop | undefined): string | undefined {
  switch (stoppedBy) {
    case "stores":
      return `Stopped at the ${CROSS_SESSION_STORE_LIMIT}-store cap; older sessions were not searched.`;
    case "hits":
      return `Stopped at the ${CROSS_SESSION_HITS_LIMIT}-hit cap; narrow the query or read one session.`;
    case "deadline":
      return `Stopped at the ${CROSS_SESSION_DEADLINE_MS} ms deadline; narrow the query.`;
    default:
      return undefined;
  }
}

/** The past sidecar a caller named, or why it cannot be read. The id is looked
 * up in the listing rather than joined into a path, so a hostile id cannot
 * escape the sidecar directory. */
export function openPastSession(
  past: PastSessions,
  callingSessionId: string | undefined,
  sessionId: string,
): { kind: "opened"; ref: SidecarRef; store: LcmStore } | { kind: "missing" | "unreadable" } {
  const ref = past.list(callingSessionId).find((candidate) => candidate.id === sessionId);
  if (ref === undefined) return { kind: "missing" };
  try {
    return { kind: "opened", ref, store: new LcmStore(ref.path, { queryOnly: true }) };
  } catch {
    return { kind: "unreadable" };
  }
}

function clampLimit(raw: number | undefined, max: number): number {
  const value = raw !== undefined && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : max;
  return Math.min(max, Math.max(1, value));
}
