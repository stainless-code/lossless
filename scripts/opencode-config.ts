import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_DIST = join(REPO_ROOT, "packages/opencode/dist");
export const BUNDLE = join(PLUGIN_DIST, "index.mjs");

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The config OpenCode itself reads: `$XDG_CONFIG_HOME/opencode/opencode.json`,
 * defaulting to `~/.config/opencode/opencode.json`. */
export function opencodeConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "opencode.json");
}

export function readConfig(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The configured plugin entry that resolves to this checkout, with its
 * `sidecarDir` option unprocessed. A relative `package` resolves from the
 * config document's directory, the way the host resolves it. */
export interface PluginBinding {
  readonly packageSpec: string;
  readonly resolved: string;
  readonly sidecarDir: string | undefined;
}

export function findPluginBinding(
  config: unknown,
  configPath: string,
  dist: string,
): PluginBinding | undefined {
  const plugins = isRecord(config) && Array.isArray(config.plugins) ? config.plugins : [];
  for (const entry of plugins) {
    if (!isRecord(entry) || typeof entry.package !== "string") continue;
    const resolved = resolve(dirname(configPath), entry.package);
    if (resolved !== dist) continue;
    const options = isRecord(entry.options) ? entry.options : {};
    return {
      packageSpec: entry.package,
      resolved,
      sidecarDir: typeof options.sidecarDir === "string" ? options.sidecarDir : undefined,
    };
  }
  return undefined;
}

/** A relative `sidecarDir` resolves from the host's working directory, which a
 * script cannot observe, so the live scripts require an absolute one. */
export function resolveSidecarDir(raw: string | undefined): string {
  if (raw === undefined) {
    fail("The plugin config has no sidecarDir; the live scripts need an absolute path.");
  }
  if (!isAbsolute(raw)) {
    fail(`sidecarDir ${raw} is relative; the live scripts need an absolute path.`);
  }
  return raw;
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requireBundle(): void {
  if (!existsSync(BUNDLE)) fail(`Bundle missing at ${BUNDLE}. Run bun run pack.`);
}

/** Open a sidecar for reading. Bun's `node:sqlite` cannot open a WAL database
 * read-only once its shared-memory file is gone, which is the state a clean
 * exit leaves behind, so that failure falls back to a normal handle with
 * writes banned on the connection. A running server closes and reopens its
 * stores during a plugin reload, so both attempts are retried before the
 * caller sees an error. */
export function openStore(path: string): DatabaseSync {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return new DatabaseSync(path, { readOnly: true });
    } catch (error) {
      lastError = error;
    }
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA query_only = ON;");
      return db;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) pause(100);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The scripts open one store at a time, so a sync wait keeps their top-level
 * flow linear. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
