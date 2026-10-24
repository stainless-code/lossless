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

export function sidecarPathFor(
  dir: string,
  sessionId: string,
  extension: string = SIDECAR_EXTENSION,
): string {
  return join(dir, `${sanitizeSidecarId(sessionId)}${extension}`);
}

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

export interface SidecarStoresOptions {
  readonly dir: string;
  readonly extension?: string;
}

/** One SQLite sidecar per session, opened on first use and held for reuse. */
export class SidecarStores {
  private readonly stores = new Map<string, LcmStore>();

  readonly dir: string;
  readonly extension: string;

  constructor(options: SidecarStoresOptions) {
    this.dir = options.dir;
    this.extension = options.extension ?? SIDECAR_EXTENSION;
    ensureSidecarDir(this.dir);
  }

  pathFor(sessionId: string): string {
    return sidecarPathFor(this.dir, sessionId, this.extension);
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

  list(excludeSessionId?: string): SidecarRef[] {
    const excluded = excludeSessionId === undefined ? undefined : this.pathFor(excludeSessionId);
    return listSidecarRefs(this.dir, {
      extension: this.extension,
      ...(excluded === undefined ? {} : { excludePath: excluded }),
    });
  }

  drop(sessionId: string): void {
    const store = this.stores.get(sessionId);
    if (store) {
      store.close();
      this.stores.delete(sessionId);
    }
    dropSidecarFiles(this.pathFor(sessionId));
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
