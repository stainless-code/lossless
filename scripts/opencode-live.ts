import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  BUNDLE,
  PLUGIN_DIST,
  fail,
  findPluginBinding,
  isRecord,
  openStore,
  opencodeConfigPath,
  readConfig,
  requireBundle,
  resolveSidecarDir,
} from "./opencode-config.ts";

interface Args {
  json: boolean;
  limit: number;
}

interface NewestRow {
  readonly entryId: string;
  readonly time: string;
}

interface StoreReport {
  readonly file: string;
  readonly path: string;
  readonly messages: number;
  readonly byRole: Record<string, number>;
  readonly compactionSummaries: number;
  readonly newest: NewestRow | null;
  readonly error?: string;
}

const ROLE_ORDER = ["user", "assistant", "toolResult", "custom"];
const IN_USE = "in use by the running server";

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=");
    const next = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--limit":
        args.limit = Number(next());
        if (!Number.isInteger(args.limit) || args.limit < 1)
          fail("--limit takes a positive integer.");
        break;
      default:
        fail(`Unknown flag ${flag}`);
    }
  }
  return args;
}

function hostVersion(): string {
  const result = spawnSync("opencode2", ["--version"], { encoding: "utf8" });
  if (result.error) fail(`Could not run opencode2: ${result.error.message}`);
  if (result.status !== 0)
    fail(`opencode2 --version exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function countByRole(db: DatabaseSync): { total: number; byRole: Record<string, number> } {
  const byRole: Record<string, number> = {};
  let total = 0;
  for (const row of db.prepare("SELECT role, COUNT(*) AS c FROM messages GROUP BY role").all()) {
    if (!isRecord(row) || typeof row.role !== "string") continue;
    const count = Number(row.c);
    byRole[row.role] = count;
    total += count;
  }
  return { total, byRole };
}

function newestRow(db: DatabaseSync): NewestRow | null {
  const row = db
    .prepare("SELECT entry_id, timestamp FROM messages ORDER BY rowid DESC LIMIT 1")
    .get();
  if (!isRecord(row) || typeof row.entry_id !== "string" || typeof row.timestamp !== "number") {
    return null;
  }
  return { entryId: row.entry_id, time: new Date(row.timestamp).toISOString() };
}

function storeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message === "unable to open database file" ? IN_USE : message;
}

function inspectStore(path: string): StoreReport {
  const file = basename(path);
  let db: DatabaseSync;
  try {
    db = openStore(path);
  } catch (error) {
    return {
      file,
      path,
      messages: 0,
      byRole: {},
      compactionSummaries: 0,
      newest: null,
      error: storeError(error),
    };
  }
  try {
    const { total, byRole } = countByRole(db);
    const summaryRow = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE instr(entry_id, ':summary:') > 0")
      .get();
    const compactionSummaries = isRecord(summaryRow) ? Number(summaryRow.c) : 0;
    return { file, path, messages: total, byRole, compactionSummaries, newest: newestRow(db) };
  } catch (error) {
    return {
      file,
      path,
      messages: 0,
      byRole: {},
      compactionSummaries: 0,
      newest: null,
      error: storeError(error),
    };
  } finally {
    db.close();
  }
}

function storeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function describeRoles(byRole: Record<string, number>): string {
  const known = ROLE_ORDER.filter((role) => (byRole[role] ?? 0) > 0).map(
    (role) => `${role} ${byRole[role]}`,
  );
  const extra = Object.keys(byRole)
    .filter((role) => !ROLE_ORDER.includes(role))
    .sort()
    .map((role) => `${role} ${byRole[role]}`);
  return [...known, ...extra].join(", ");
}

function storeLine(store: StoreReport): string {
  if (store.error !== undefined) return `  ${store.file}: unreadable (${store.error})`;
  const newest =
    store.newest === null
      ? "newest none"
      : `newest ${store.newest.entryId} at ${store.newest.time}`;
  return `  ${store.file}: ${store.messages} messages (${describeRoles(store.byRole)}), ${store.compactionSummaries} compaction summaries, ${newest}`;
}

const args = parseArgs(process.argv.slice(2));
requireBundle();

const configPath = opencodeConfigPath();
if (!existsSync(configPath)) fail(`No OpenCode config at ${configPath}.`);

const config = readConfig(configPath);
const binding = findPluginBinding(config, configPath, PLUGIN_DIST);
if (!binding) fail(`${configPath} has no plugins entry pointing at ${PLUGIN_DIST}.`);

const sidecarDir = resolveSidecarDir(binding.sidecarDir);
const bundleStat = statSync(BUNDLE);
const allStores = storeFiles(sidecarDir);
const shown = allStores.slice(0, args.limit).map(inspectStore);

if (args.json) {
  console.log(
    JSON.stringify(
      {
        host: hostVersion(),
        config: configPath,
        plugin: {
          package: binding.packageSpec,
          resolved: binding.resolved,
          bundle: BUNDLE,
          bundleSha256: sha256(BUNDLE),
          bundleMtime: bundleStat.mtime.toISOString(),
        },
        sidecarDir,
        stores: shown,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`OpenCode host: ${hostVersion()}`);
  console.log(`Config: ${configPath}`);
  console.log(`Plugin: ${binding.resolved} (configured as ${binding.packageSpec})`);
  console.log(`Bundle: ${BUNDLE}`);
  console.log(`  sha256 ${sha256(BUNDLE)}`);
  console.log(`  mtime  ${bundleStat.mtime.toISOString()}`);
  console.log(`Sidecar dir: ${sidecarDir}`);
  if (allStores.length === 0) {
    console.log(
      existsSync(sidecarDir)
        ? "Stores: none yet"
        : `Stores: none yet (no directory at ${sidecarDir})`,
    );
  } else {
    const suffix =
      allStores.length > shown.length ? ` (showing ${shown.length} of ${allStores.length})` : "";
    console.log(`Stores: ${allStores.length}${suffix}`);
    for (const store of shown) console.log(storeLine(store));
  }
}

if (shown.some((store) => store.error !== undefined && store.error !== IN_USE)) {
  process.exitCode = 1;
}
