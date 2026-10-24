import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { LcmStore } from "../store.ts";

/** One sidecar on disk, named by its file stem. */
export interface SidecarRef {
  readonly id: string;
  readonly path: string;
}

/** File suffix for sidecar databases. OpenCode uses `.sqlite`. */
export const SIDECAR_EXTENSION = ".sqlite";

/** Replace every character a session id cannot carry with `_`. */
export function sanitizeSidecarId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Create the sidecar directory when missing, then repair its mode. */
export function ensureSidecarDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Sidecar file for a session id: sanitized stem plus extension, joined under the sidecar dir. */
export function sidecarPathFor(
  dir: string,
  sessionId: string,
  extension: string = SIDECAR_EXTENSION,
): string {
  return join(dir, `${sanitizeSidecarId(sessionId)}${extension}`);
}

/** Live sidecar refs newest-first (mtime, then id); skips non-files and one optionally excluded path. */
export function listSidecarRefs(
  dir: string,
  opts: { extension?: string; excludePath?: string } = {},
): SidecarRef[] {
  const extension = opts.extension ?? SIDECAR_EXTENSION;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const listed: Array<SidecarRef & { mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(extension)) continue;
    const path = join(dir, name);
    if (opts.excludePath !== undefined && path === opts.excludePath) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      listed.push({
        id: name.slice(0, -extension.length),
        path,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return listed
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))
    .map(({ id, path }) => ({ id, path }));
}

/** Delete a sidecar database and its WAL and shared-memory files. */
export function dropSidecarFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}

/** Where sidecars live and which extension names them; defaults to `.sqlite`. */
export interface SidecarStoresOptions {
  readonly dir: string;
  readonly extension?: string;
}

/** One SQLite sidecar per session, opened on first use and held for reuse. */
export class SidecarStores {
  private readonly stores = new Map<string, LcmStore>();

  /** Sidecar directory this cache reads and writes. */
  readonly dir: string;
  /** File extension naming sidecar databases, including the leading dot. */
  readonly extension: string;

  /** Open the cache, creating the dir (mode 0700) when missing; stores open lazily. */
  constructor(options: SidecarStoresOptions) {
    this.dir = options.dir;
    this.extension = options.extension ?? SIDECAR_EXTENSION;
    ensureSidecarDir(this.dir);
  }

  /** File path for one session id under this cache's dir and extension. */
  pathFor(sessionId: string): string {
    return sidecarPathFor(this.dir, sessionId, this.extension);
  }

  /** Open-once store for a session id, reused across calls until dropped or closed. */
  for(sessionId: string): LcmStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = new LcmStore(this.pathFor(sessionId));
      this.stores.set(sessionId, store);
    }
    return store;
  }

  /** Open store already held for a session id, if any, without opening one. */
  peek(sessionId: string): LcmStore | undefined {
    return this.stores.get(sessionId);
  }

  /** Session ids with an open store in this cache. */
  ids(): string[] {
    return [...this.stores.keys()];
  }

  /** Live sidecar refs newest-first, optionally excluding one session id. */
  list(excludeSessionId?: string): SidecarRef[] {
    const excluded = excludeSessionId === undefined ? undefined : this.pathFor(excludeSessionId);
    return listSidecarRefs(this.dir, {
      extension: this.extension,
      ...(excluded === undefined ? {} : { excludePath: excluded }),
    });
  }

  /** Close the held store, forget it, and delete its database plus WAL and SHM files. */
  drop(sessionId: string): void {
    const store = this.stores.get(sessionId);
    if (store) {
      store.close();
      this.stores.delete(sessionId);
    }
    dropSidecarFiles(this.pathFor(sessionId));
  }

  /** Close every held store and forget them; files stay on disk. */
  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
