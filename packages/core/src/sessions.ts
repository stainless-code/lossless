import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

import { hashSessionPath } from "./retention.ts";
import { LcmStore, StaleStoreError, type GrepHit } from "./store.ts";

/** How much of a session file is read to get its header. The cap never reads a
 * transcript and still bounds the read. */
const HEADER_CHARS = 8_192;

/** Most recent past sessions one scan considers. A cap, not a promise: the
 * deadline below is what bounds the work. */
export const SESSION_SCAN_LIMIT = 20;

/** Session headers one listing reads before it picks the newest `SESSION_SCAN_LIMIT`.
 * A header is one small read, so a few hundred sessions cost one syscall each. */
export const SESSION_HEADER_CAP = 200;

/** Wall-clock budget for one cross-session search. A scan that runs out returns
 * what it found and says it was truncated. */
export const SESSION_SEARCH_DEADLINE_MS = 1_500;

export const SESSION_HITS_LIMIT = 40;

export interface SessionRef {
  hash: string;
  sessionFile: string;
  storePath: string;
  cwd: string;
  sessionId: string;
  /** Header timestamp in ms, or the file's mtime when the header has none. */
  when: number;
}

/** Why a candidate past session could not be searched. Each reason is a count the
 * caller reports, never an error it raises: a store this build cannot read is
 * skipped, not migrated. */
export type SessionSkip = "missing" | "unreadable" | "older-generation";

/** Line 1 of a session file: `{"type":"session","id":...,"timestamp":...,
 * "cwd":...}`. Reading stops at the first newline, so a session with a broken
 * line 2 still lists. */
const HEADER_LINE = Type.Object({
  type: Type.Literal("session"),
  cwd: Type.String(),
  id: Type.String(),
  timestamp: Type.String(),
});

const headerValidator = Compile(HEADER_LINE);

export function readSessionHeader(
  sessionFile: string,
): Omit<Static<typeof HEADER_LINE>, "type"> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(HEADER_CHARS);
    const read = readSync(fd, buffer, 0, HEADER_CHARS, 0);
    if (read <= 0) return undefined;
    const chunk = buffer.subarray(0, read).toString("utf8");
    const newline = chunk.indexOf("\n");
    const line = newline === -1 ? chunk : chunk.slice(0, newline);
    const parsed: unknown = JSON.parse(line);
    if (!headerValidator.Check(parsed)) return undefined;
    return { cwd: parsed.cwd, id: parsed.id, timestamp: parsed.timestamp };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function sessionStorePath(storesDir: string, sessionFile: string): string {
  return join(storesDir, `${hashSessionPath(sessionFile)}.db`);
}

function timestampOf(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function listSessions(opts: {
  sessionsRoot: string;
  storesDir: string;
  cwd?: string;
  limit?: number;
  /** How deep to walk. Pi nests one directory per project cwd, so 4 is slack. */
  maxDepth?: number;
  excludeHash?: string;
}): SessionRef[] {
  const limit = Math.max(1, opts.limit ?? SESSION_SCAN_LIMIT);
  const cap = Math.max(limit, SESSION_HEADER_CAP);
  // Two phases: a cap applied during the walk would keep the first sessions the
  // directory happened to list rather than the newest, so every candidate up to
  // the header cap is collected and then sorted by header time.
  const out: SessionRef[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= cap || depth > (opts.maxDepth ?? 4)) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const header = readSessionHeader(path);
      if (!header) continue;
      if (opts.cwd !== undefined && header.cwd !== opts.cwd) continue;
      const hash = hashSessionPath(path);
      if (opts.excludeHash !== undefined && hash === opts.excludeHash) continue;
      const storePath = sessionStorePath(opts.storesDir, path);
      try {
        if (!statSync(storePath).isFile()) continue;
      } catch {
        continue;
      }
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {}
      out.push({
        hash,
        sessionFile: path,
        storePath,
        cwd: header.cwd,
        sessionId: header.id,
        when: timestampOf(header.timestamp, mtime),
      });
      if (out.length >= cap) return;
    }
  };
  walk(opts.sessionsRoot, 0);
  return out.sort((a, b) => b.when - a.when).slice(0, limit);
}

/** The generation a store file carries, read without migrating it. `undefined`
 * when the file cannot be read at all. */
export function storeGeneration(storePath: string): number | undefined {
  let store: LcmStore | undefined;
  try {
    store = new LcmStore(storePath, { readOnly: true });
    return store.generation;
  } catch (e) {
    if (e instanceof StaleStoreError) return e.generation;
  } finally {
    store?.close();
  }
  try {
    store = new LcmStore(storePath, { queryOnly: true });
    return store.generation;
  } catch (e) {
    if (e instanceof StaleStoreError) return e.generation;
    return undefined;
  } finally {
    store?.close();
  }
}

export function openSessionStore(
  ref: SessionRef,
): { kind: "opened"; store: LcmStore } | { kind: "skipped"; reason: SessionSkip } {
  try {
    if (!statSync(ref.storePath).isFile()) return { kind: "skipped", reason: "missing" };
  } catch {
    return { kind: "skipped", reason: "missing" };
  }
  try {
    return { kind: "opened", store: new LcmStore(ref.storePath, { readOnly: true }) };
  } catch (e) {
    if (e instanceof StaleStoreError) return { kind: "skipped", reason: "older-generation" };
  }
  try {
    return { kind: "opened", store: new LcmStore(ref.storePath, { queryOnly: true }) };
  } catch (e) {
    if (e instanceof StaleStoreError) return { kind: "skipped", reason: "older-generation" };
    return { kind: "skipped", reason: "unreadable" };
  }
}

export interface SessionHit extends GrepHit {
  session: string;
  sessionId: string;
  cwd: string;
  when: number;
}

export interface SessionSearchResult {
  hits: SessionHit[];
  scanned: number;
  skipped: Record<SessionSkip, number>;
  /** True when the deadline or the hit cap ended the scan early. */
  truncated: boolean;
  elapsedMs: number;
}

export function searchSessions(
  refs: readonly SessionRef[],
  query: string,
  opts?: {
    limit?: number;
    deadlineMs?: number;
    perSession?: number;
    now?: () => number;
  },
): SessionSearchResult {
  const now = opts?.now ?? Date.now;
  const started = now();
  const deadline = started + Math.max(1, opts?.deadlineMs ?? SESSION_SEARCH_DEADLINE_MS);
  const limit = Math.max(1, opts?.limit ?? SESSION_HITS_LIMIT);
  const perSession = Math.max(1, opts?.perSession ?? 10);
  const hits: SessionHit[] = [];
  const skipped: Record<SessionSkip, number> = {
    missing: 0,
    unreadable: 0,
    "older-generation": 0,
  };
  let scanned = 0;
  let truncated = false;
  for (const ref of refs) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    if (now() > deadline) {
      truncated = true;
      break;
    }
    const opened = openSessionStore(ref);
    if (opened.kind === "skipped") {
      skipped[opened.reason]++;
      continue;
    }
    const store = opened.store;
    try {
      const found = searchStore(store, query, Math.min(perSession, limit - hits.length));
      scanned++;
      for (const hit of found) {
        hits.push({
          ...hit,
          session: ref.hash,
          sessionId: ref.sessionId,
          cwd: ref.cwd,
          when: ref.when,
        });
      }
    } catch {
      skipped.unreadable++;
    } finally {
      store.close();
    }
  }
  return { hits, scanned, skipped, truncated, elapsedMs: now() - started };
}

export const SEARCH_SCOPE_HELP =
  "session (default) searches this session. sessions searches past sessions in this project's working directory. all_sessions searches past sessions in every project. A cross-session hit is a pointer labelled [lcm:session <hash>] that lcm_expand_query({session, entry_id}) reads, so a past session's text is never injected into the context on its own.";

/** Chars of a past session's hit one line carries. A hit is a pointer and a
 * preview, so the rest is what lcm_expand_query is for. */
const SESSION_HIT_CHARS = 400;

/** The cross-session hits as one labelled block, plus what the scan did not read.
 * `redact` is required because this hands a past session's stored text to a
 * model, and that store holds secrets this session's mask has to reach. */
export function formatSessionHits(
  result: SessionSearchResult,
  redact: (text: string) => string,
): string {
  if (result.hits.length === 0) {
    const skipped = skippedNote(result.skipped);
    // A scan that ran out of clock is not the same answer as a scan that read
    // everything and found nothing: "no matches" would claim stores were read.
    const stopped = result.truncated
      ? "; the scan was truncated before it finished, so this is not a complete answer"
      : "";
    return `No matches in ${result.scanned} past session(s)${skipped}${stopped}.`;
  }
  const sessions = new Set(result.hits.map((h) => h.session)).size;
  const lines = [
    `Found ${result.hits.length} match(es) across ${sessions} past session(s) in ${result.elapsedMs} ms (scanned ${result.scanned}${skippedNote(result.skipped)}).`,
  ];
  for (const hit of result.hits) {
    const pointer = hit.coveringSummaryId === undefined ? "" : ` #${hit.coveringSummaryId}`;
    const removed = hit.removed === true ? " [removed]" : "";
    const flat = redact(hit.text).replace(/\s+/g, " ").trim();
    const shown = flat.length <= SESSION_HIT_CHARS ? flat : `${flat.slice(0, SESSION_HIT_CHARS)}…`;
    lines.push(
      `[lcm:session ${hit.session} ${new Date(hit.when).toISOString().slice(0, 10)} ${hit.cwd}] [${hit.entryId}] (${hit.role})${pointer}${removed} ${shown}`,
    );
  }
  if (result.truncated) {
    lines.push(
      `… scan truncated (deadline or ${SESSION_HITS_LIMIT}-hit cap). Narrow the query or search a specific session.`,
    );
  }
  return lines.join("\n");
}

function skippedNote(skipped: Record<SessionSkip, number>): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`);
  return parts.length === 0 ? "" : `, skipped ${parts.join(", ")}`;
}

export function sessionsForScope(opts: {
  scope: "sessions" | "all_sessions";
  sessionsRoot: string;
  storesDir: string;
  cwd: string;
  excludeHash?: string;
  limit?: number;
}): SessionRef[] {
  return listSessions({
    sessionsRoot: opts.sessionsRoot,
    storesDir: opts.storesDir,
    ...(opts.scope === "sessions" ? { cwd: opts.cwd } : {}),
    ...(opts.excludeHash === undefined ? {} : { excludeHash: opts.excludeHash }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  });
}

function searchStore(store: LcmStore, query: string, limit: number): GrepHit[] {
  try {
    return store.grep(query, { limit });
  } catch {
    try {
      return store.grep(JSON.stringify(query), { limit });
    } catch {
      return [];
    }
  }
}
