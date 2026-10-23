import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { LcmStore } from "lossless-core";

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** One sidecar on disk, named by its file stem. The stem is the sanitized
 * session id, which is what a cross-session hit reports: an OpenCode session id
 * keeps only letters, digits, `_`, and `-`, so the stem and the id agree. */
export interface SidecarRef {
  readonly id: string;
  readonly path: string;
}

/** One SQLite sidecar per OpenCode session, opened on first use and held for
 * the plugin lifetime. Reads through `peek` never create a store, so recall
 * tools against a session with no history answer explained instead of
 * conjuring an empty database file. */
export class Sidecars {
  private readonly stores = new Map<string, LcmStore>();

  constructor(readonly dir: string) {
    // The mode applies only to a directory this call creates, so repair an
    // existing directory as well.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  pathFor(sessionId: string): string {
    return join(this.dir, `${sanitize(sessionId)}.sqlite`);
  }

  for(sessionId: string): LcmStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = new LcmStore(this.pathFor(sessionId));
      this.stores.set(sessionId, store);
    }
    return store;
  }

  peek(sessionId: string): LcmStore | undefined {
    return this.stores.get(sessionId);
  }

  ids(): string[] {
    return [...this.stores.keys()];
  }

  /** The sidecars on disk other than `excludeSessionId`, newest first. A
   * session this process has not opened is included: cross-session recall reads
   * files it never created. The calling session's file is skipped by path, so
   * an id that was never opened is still excluded. */
  list(excludeSessionId?: string): SidecarRef[] {
    const excluded = excludeSessionId === undefined ? undefined : this.pathFor(excludeSessionId);
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const listed: Array<SidecarRef & { mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".sqlite")) continue;
      const path = join(this.dir, name);
      if (path === excluded) continue;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        listed.push({
          id: name.slice(0, -".sqlite".length),
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

  /** Close one sidecar and delete its database, WAL, and shared-memory file.
   * A reader child's store is a transcript nothing else reads, so it goes with
   * the child. Missing files are fine: the store may never have been opened. */
  drop(sessionId: string): void {
    const store = this.stores.get(sessionId);
    if (store) {
      store.close();
      this.stores.delete(sessionId);
    }
    const path = this.pathFor(sessionId);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
