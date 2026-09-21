import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const SCRATCH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DbFootprint {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface GcCandidate {
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  reason: "session-gone" | "scratch-expired";
}

export function hashSessionPath(sessionFilePath: string): string {
  return createHash("sha256").update(sessionFilePath).digest("hex").slice(0, 16);
}

export function listDbFootprints(dir: string): DbFootprint[] {
  const out: DbFootprint[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".db")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ path, name, sizeBytes: st.size, modifiedAt: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function retentionCandidates(opts: {
  dir: string;
  liveDbPath: string | undefined;
  sessionPathHashes: ReadonlySet<string>;
  now: number;
  scratchMaxAgeMs: number;
}): GcCandidate[] {
  const candidates: GcCandidate[] = [];
  for (const fp of listDbFootprints(opts.dir)) {
    if (opts.liveDbPath && fp.path === opts.liveDbPath) continue;
    if (fp.name.startsWith("scratch-")) {
      if (opts.now - fp.modifiedAt > opts.scratchMaxAgeMs) {
        candidates.push({
          path: fp.path,
          sizeBytes: fp.sizeBytes,
          modifiedAt: fp.modifiedAt,
          reason: "scratch-expired",
        });
      }
      continue;
    }
    const hash = basename(fp.name, ".db");
    if (!opts.sessionPathHashes.has(hash)) {
      candidates.push({
        path: fp.path,
        sizeBytes: fp.sizeBytes,
        modifiedAt: fp.modifiedAt,
        reason: "session-gone",
      });
    }
  }
  return candidates;
}
