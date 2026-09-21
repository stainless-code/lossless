import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

import { lcmHomePath } from "lossless-core";
import type { ZoneThresholds } from "lossless-core";

export interface LcmConfig {
  summarizer?: string | string[];
  smartZone?: number;
  swapAtTokens?: number;
  recutAtTokens?: number;
  swapAtRatio?: number;
  recutAtRatio?: number;
  zones?: Record<string, ZoneThresholds>;
  summaryTokens?: number;
  leafChunkTokens?: number;
  keepRecentTokens?: number;
  maxAsyncChunks?: number;
  redactSecrets?: boolean;
  assemblyEnabled?: boolean;
  largeFileChars?: number;
  externalizeFiles?: boolean;
  summarizerTokensPerCall?: number;
  summarizerTokensPerPass?: number;
}

export const DEFAULT_CONFIG: LcmConfig = {
  summarizer: "auto",
  swapAtRatio: 0.7,
  recutAtRatio: 0.85,
  keepRecentTokens: 20_000,
  summaryTokens: 1500,
  leafChunkTokens: 3000,
  maxAsyncChunks: 24,
  redactSecrets: true,
  assemblyEnabled: true,
  largeFileChars: 32_000,
  externalizeFiles: true,
  summarizerTokensPerCall: 60_000,
  summarizerTokensPerPass: 250_000,
};

export interface PassConditions {
  summarizer: string;
  summaryTokens: number;
  leafChunkTokens: number;
  maxAsyncChunks: number;
  redactSecrets: boolean;
}

const PASS_CONDITION_KEYS = [
  "summarizer",
  "summaryTokens",
  "leafChunkTokens",
  "maxAsyncChunks",
  "redactSecrets",
] as const satisfies readonly (keyof PassConditions)[];

export function passConditions(config: LcmConfig): PassConditions {
  return {
    summarizer: JSON.stringify(config.summarizer ?? "auto"),
    summaryTokens: config.summaryTokens ?? 1500,
    leafChunkTokens: config.leafChunkTokens ?? 3000,
    maxAsyncChunks: config.maxAsyncChunks ?? 24,
    redactSecrets: config.redactSecrets !== false,
  };
}

export function changedPassConditions(
  before: PassConditions,
  after: PassConditions,
): Array<keyof PassConditions> {
  return PASS_CONDITION_KEYS.filter((key) => before[key] !== after[key]);
}

export interface PassIdentity {
  model: string;
  settings: PassConditions;
}

export function staleReason(
  kickedUnder: PassIdentity,
  now: PassIdentity,
):
  | { reason: "model-changed" | "settings-changed"; changed: Array<keyof PassConditions> }
  | undefined {
  const changed = changedPassConditions(kickedUnder.settings, now.settings);
  if (kickedUnder.model !== now.model) return { reason: "model-changed", changed };
  if (changed.length > 0) return { reason: "settings-changed", changed };
  return undefined;
}

export function lcmConfigPath(): string {
  return lcmHomePath("lcm.json");
}

export function lcmConfigBackupPath(path: string = lcmConfigPath()): string {
  return `${path}.bak`;
}

const NUMBER_KEYS = [
  "smartZone",
  "swapAtTokens",
  "recutAtTokens",
  "swapAtRatio",
  "recutAtRatio",
  "summaryTokens",
  "leafChunkTokens",
  "keepRecentTokens",
  "maxAsyncChunks",
  "largeFileChars",
  "summarizerTokensPerCall",
  "summarizerTokensPerPass",
] as const satisfies readonly (keyof LcmConfig)[];
const BOOLEAN_KEYS = [
  "redactSecrets",
  "assemblyEnabled",
  "externalizeFiles",
] as const satisfies readonly (keyof LcmConfig)[];
const ZONE_KEYS = [
  "smartZone",
  "swapAtTokens",
  "recutAtTokens",
  "swapAtRatio",
  "recutAtRatio",
] as const satisfies readonly (keyof ZoneThresholds)[];
const ZONE_KEY_SET: ReadonlySet<string> = new Set(ZONE_KEYS);
const NUMBER_RANGES = {
  smartZone: (v: number) => v >= 0,
  swapAtTokens: (v: number) => v >= 0,
  recutAtTokens: (v: number) => v >= 0,
  swapAtRatio: (v: number) => v > 0 && v <= 1,
  recutAtRatio: (v: number) => v > 0 && v <= 1,
  summaryTokens: (v: number) => v >= 1,
  leafChunkTokens: (v: number) => v >= 1,
  keepRecentTokens: (v: number) => v >= 0,
  maxAsyncChunks: (v: number) => v >= 1,
  // Below this a described body is smaller than most reads, and the handle
  // costs more than the bytes it replaces.
  largeFileChars: (v: number) => v >= 1000,
  summarizerTokensPerCall: (v: number) => v >= 1,
  summarizerTokensPerPass: (v: number) => v >= 1,
} satisfies Record<(typeof NUMBER_KEYS)[number], (v: number) => boolean>;
const KNOWN_KEYS: ReadonlySet<string> = new Set<keyof LcmConfig>([
  ...NUMBER_KEYS,
  ...BOOLEAN_KEYS,
  "summarizer",
  "zones",
]);

export interface ParsedLcmConfig {
  config: LcmConfig;
  dropped: string[];
  notes: string[];
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseLcmConfig(raw: unknown): ParsedLcmConfig {
  if (!isPlainObject(raw)) return { config: {}, dropped: ["(root is not an object)"], notes: [] };
  const dropped: string[] = [];
  const notes: string[] = [];
  const config: LcmConfig = {};
  for (const key of NUMBER_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isFiniteNumber(v)) {
      dropped.push(`${key} (wrong type)`);
      continue;
    }
    if (!NUMBER_RANGES[key](v)) {
      dropped.push(`${key} (out of range)`);
      continue;
    }
    config[key] = v;
  }
  for (const key of BOOLEAN_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") config[key] = v;
    else dropped.push(`${key} (wrong type)`);
  }
  const summarizer = parseSummarizer(raw.summarizer, dropped, notes);
  if (summarizer !== undefined) config.summarizer = summarizer;
  if (raw.zones !== undefined) {
    if (isPlainObject(raw.zones)) {
      const zones: Record<string, ZoneThresholds> = {};
      for (const [name, z] of Object.entries(raw.zones)) {
        if (!isPlainObject(z)) {
          dropped.push(`zones.${name} (not an object)`);
          continue;
        }
        const zone: ZoneThresholds = {};
        for (const key of ZONE_KEYS) {
          const v = z[key];
          if (v === undefined) continue;
          if (!isFiniteNumber(v)) {
            dropped.push(`zones.${name}.${key} (wrong type)`);
            continue;
          }
          if (!NUMBER_RANGES[key](v)) {
            dropped.push(`zones.${name}.${key} (out of range)`);
            continue;
          }
          zone[key] = v;
        }
        for (const key of Object.keys(z))
          if (!ZONE_KEY_SET.has(key)) dropped.push(`zones.${name}.${key} (unknown key)`);
        // An empty zone would still read as an active override in the cockpit.
        if (Object.keys(zone).length > 0) zones[name] = zone;
      }
      if (Object.keys(zones).length > 0) config.zones = zones;
    } else {
      dropped.push("zones (not an object)");
    }
  }
  for (const key of Object.keys(raw))
    if (!KNOWN_KEYS.has(key)) dropped.push(`${key} (unknown key)`);
  return { config, dropped, notes };
}

function parseSummarizer(
  raw: unknown,
  dropped: string[],
  notes: string[],
): string | string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const id = raw.trim();
    if (id.length > 0) return id;
    notes.push("summarizer is empty; the session model is used");
    return undefined;
  }
  if (!Array.isArray(raw)) {
    dropped.push("summarizer (wrong type)");
    return undefined;
  }
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "string") {
      dropped.push(`summarizer[${i}] (wrong type)`);
      continue;
    }
    const id = entry.trim();
    if (id.length === 0) {
      notes.push(`summarizer[${i}] is empty; entry dropped`);
      continue;
    }
    if (seen.has(id)) {
      notes.push(`summarizer[${i}] repeats "${id}"; entry dropped`);
      continue;
    }
    seen.add(id);
    entries.push(id);
  }
  if (entries.length === 0) {
    notes.push("summarizer has no usable entries; the session model is used");
    return undefined;
  }
  return entries.length === 1 ? entries[0] : entries;
}

function copyAside(path: string, backup: string): string {
  try {
    copyFileSync(path, backup);
    try {
      chmodSync(backup, 0o600);
    } catch {}
    return `original saved to ${backup}`;
  } catch (error) {
    return `backup failed (${error instanceof Error ? error.message : String(error)}), original left in place`;
  }
}

function backupRejectedConfig(path: string): string {
  const base = `${path}.corrupt`;
  return copyAside(path, existsSync(base) ? `${base}.${Date.now()}` : base);
}

function backupBeforeOverwrite(path: string): void {
  const backup = lcmConfigBackupPath(path);
  if (!existsSync(path) || existsSync(backup)) return;
  copyAside(path, backup);
}

export function readLcmConfig(): { config: LcmConfig; problems: string[] } {
  const path = lcmConfigPath();
  if (!existsSync(path)) return { config: {}, problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      config: {},
      problems: [`is corrupt, using defaults; ${backupRejectedConfig(path)}`],
    };
  }
  const { config, dropped, notes } = parseLcmConfig(raw);
  const problems = [...notes];
  if (dropped.length > 0) {
    problems.push(`ignored ${dropped.join(", ")}; defaults apply; ${backupRejectedConfig(path)}`);
  }
  return { config, problems };
}

export function writeLcmConfig(config: LcmConfig): void {
  const path = lcmConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  backupBeforeOverwrite(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, path);
}

export function cycle<T>(list: readonly T[], current: T, dir: 1 | -1): T {
  const i = list.indexOf(current);
  if (i === -1) return list[0] ?? current;
  const next = (i + dir + list.length) % list.length;
  return list[next]!;
}
