import { resolve } from "node:path";

import { SidecarStores, redactSecrets, type LcmStore } from "lossless-core";

import { checkpointMemory, type CheckpointMemory } from "./engine.ts";
import { MessageIndex } from "./ingest.ts";
import { createRecord } from "./metrics.ts";

/** Directory default shared with the loader schema. */
export const DEFAULT_SIDECAR_DIR = "./.lossless";

/** Per-session sidecars: stores delegate to the shared core seam while each
 * session keeps its own live message index beside its store. */
export class SessionSidecars extends SidecarStores {
  private readonly indexes = new Map<string, MessageIndex>();

  constructor(dir: string) {
    super({ dir });
  }

  entryFor(sessionId: string): { store: LcmStore; index: MessageIndex } {
    const store = this.for(sessionId);
    let index = this.indexes.get(sessionId);
    if (!index) {
      index = new MessageIndex();
      this.indexes.set(sessionId, index);
    }
    return { store, index };
  }

  peekIndex(sessionId: string): MessageIndex | undefined {
    return this.indexes.get(sessionId);
  }

  storesMap(): Map<string, LcmStore> {
    const map = new Map<string, LcmStore>();
    for (const id of this.ids()) {
      const store = this.peek(id);
      if (store) map.set(id, store);
    }
    return map;
  }

  override clear(): void {
    super.clear();
    this.indexes.clear();
  }

  override evict(sessionId: string): void {
    super.evict(sessionId);
    this.indexes.delete(sessionId);
  }
}

/** Shared composition state: one per sidecar directory per process. The host
 * row owns it (creates on mount, closes on dispose). Preset-realm backends
 * borrow it and never close it. */
export interface LosslessCore {
  /** Resolved sidecar directory this core writes. */
  readonly dir: string;
  readonly sidecars: SessionSidecars;
  readonly record: (row: Record<string, unknown>) => void;
  readonly memory: CheckpointMemory;
  /** Redaction for recall surfaces. */
  readonly redact: typeof redactSecrets;
}

const cores = new Map<string, { core: LosslessCore; owners: number }>();

/** Resolve the registry key so host and realm rows naming the same directory
 * share one core even when one side passes a relative path. */
export function resolveCoreDir(dir: string): string {
  return resolve(dir);
}

/** Tool names that skip the model. One name or a list; blanks and repeats
 * drop, and an empty result keeps the LLM path. */
export function readMechanicalTools(raw: unknown): string[] | undefined {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (list === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length === 0 ? undefined : out;
}

/** Borrow or create the core for a directory. Host rows pass owner true and
 * take disposal duty. Realm rows pass owner false and fail fast when the host
 * row has not mounted, instead of running a split-brain copy. */
export function acquireCore(dir: string, owner: boolean): LosslessCore {
  const key = resolveCoreDir(dir);
  const held = cores.get(key);
  if (held !== undefined) {
    if (owner) held.owners += 1;
    return held.core;
  }
  if (!owner) {
    throw new Error(
      `deepseek-lossless: no shared core for "${dir}". Enable the deepseek-lossless host row (enabled: true) in the same profile so the mirror, tools, and sidecars mount first.`,
    );
  }
  const sidecars = new SessionSidecars(key);
  const core: LosslessCore = {
    dir: key,
    sidecars,
    record: createRecord(key),
    memory: checkpointMemory((sessionId) => sidecars.peek(sessionId)),
    redact: redactSecrets,
  };
  cores.set(key, { core, owners: 1 });
  return core;
}

/** Release a core. Tied to the acquired core object, not the directory: a
 * stale disposer from a previous mount cannot release the replacement. Each
 * disposer must also call this at most once (guarded at the call site), so a
 * double dispose after a remount cannot spend the replacement's ownership.
 * Realm rows never call it and never touch shared handles. */
export function releaseCore(core: LosslessCore): void {
  const held = cores.get(core.dir);
  if (held === undefined || held.core !== core) return;
  held.owners -= 1;
  if (held.owners > 0) return;
  cores.delete(core.dir);
}
