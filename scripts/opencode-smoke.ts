import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

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
  sanitizeSessionId,
} from "./opencode-config.ts";

interface Args {
  model: string | undefined;
  keep: boolean;
  timeoutMs: number;
}

const PROMPT = "Reply with exactly: pong.";
const FALLBACK_MODEL = "opencode-go/deepseek-v4.1-flash";

function parseArgs(argv: string[]): Args {
  const args: Args = { model: undefined, keep: false, timeoutMs: 240_000 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=");
    const next = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--model":
        args.model = next();
        if (args.model === "") fail("--model needs a provider/model[#variant] value.");
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1) {
          fail("--timeout-ms takes a positive integer.");
        }
        break;
      default:
        fail(`Unknown flag ${flag}`);
    }
  }
  return args;
}

function configuredModel(config: unknown): string | undefined {
  return isRecord(config) && typeof config.model === "string" ? config.model : undefined;
}

function modeOf(path: string): number | undefined {
  return existsSync(path) ? statSync(path).mode & 0o777 : undefined;
}

function assertMode(path: string, expected: number, label: string, problems: string[]): void {
  const mode = modeOf(path);
  if (mode === undefined) {
    problems.push(`${label} is missing at ${path}`);
    return;
  }
  if (mode !== expected) {
    problems.push(`${label} ${path} is ${mode.toString(8)}, expected ${expected.toString(8)}`);
    return;
  }
  console.log(`PASS ${label} ${path} mode ${mode.toString(8)}`);
}

interface RowHit {
  readonly entryId: string;
  readonly text: string;
}

function findRow(db: DatabaseSync, role: string): RowHit | undefined {
  const row = db
    .prepare(
      "SELECT entry_id, text FROM messages WHERE role = ? AND text LIKE '%pong%' ORDER BY rowid ASC LIMIT 1",
    )
    .get(role);
  if (!isRecord(row) || typeof row.entry_id !== "string" || typeof row.text !== "string") {
    return undefined;
  }
  return { entryId: row.entry_id, text: row.text };
}

async function waitForRows(
  path: string,
): Promise<{ user: RowHit | undefined; assistant: RowHit | undefined }> {
  let found: { user: RowHit | undefined; assistant: RowHit | undefined } = {
    user: undefined,
    assistant: undefined,
  };
  // The assistant text crosses the bus after the client prints its response,
  // so the sidecar can lag the process exit by a few hundred milliseconds.
  for (let attempt = 0; attempt < 25; attempt++) {
    if (existsSync(path)) {
      const db = openStore(path);
      try {
        found = { user: findRow(db, "user"), assistant: findRow(db, "assistant") };
      } finally {
        db.close();
      }
      if (found.user && found.assistant) return found;
    }
    await sleep(200);
  }
  return found;
}

function removeSidecar(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(file, { force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
requireBundle();

const configPath = opencodeConfigPath();
if (!existsSync(configPath)) fail(`No OpenCode config at ${configPath}.`);
const config = readConfig(configPath);
const binding = findPluginBinding(config, configPath, PLUGIN_DIST);
if (!binding) fail(`${configPath} has no plugins entry pointing at ${PLUGIN_DIST}.`);

const model = args.model ?? configuredModel(config) ?? FALLBACK_MODEL;
const sidecarDir = resolveSidecarDir(binding.sidecarDir);
const sessionId = `ses_lossless_smoke_${Date.now()}`;
const sidecar = join(sidecarDir, `${sanitizeSessionId(sessionId)}.sqlite`);
// The temp directory stays in place: the shared server keeps the session's
// location registered, and removing it fails the next `opencode2 reload`.
const cwd = mkdtempSync(join(tmpdir(), "opencode-lossless-smoke-"));

console.log(`OpenCode config: ${configPath}`);
console.log(`Plugin bundle: ${BUNDLE}`);
console.log(`Sidecar dir: ${sidecarDir}`);
console.log(`Session: ${sessionId}`);
console.log(`Model: ${model}`);
console.log(`Run cwd: ${cwd}`);
console.log(`Running: opencode2 run --session ${sessionId} -m ${model} "${PROMPT}"`);

const result = spawnSync("opencode2", ["run", "--session", sessionId, "-m", model, PROMPT], {
  cwd,
  // The host resolves the session directory from PWD, not the process cwd.
  env: { ...process.env, PWD: cwd },
  encoding: "utf8",
  timeout: args.timeoutMs,
});

if (result.error) {
  fail(`opencode2 run could not complete: ${result.error.message}`);
}
if (result.signal !== null) {
  fail(
    `opencode2 run was killed by ${result.signal} after ${args.timeoutMs}ms.\nstdout: ${result.stdout.trim()}\nstderr: ${result.stderr.trim()}`,
  );
}
if (result.status !== 0) {
  fail(
    `opencode2 run exited ${result.status}.\nstdout: ${result.stdout.trim()}\nstderr: ${result.stderr.trim()}`,
  );
}
console.log("PASS opencode2 run exited 0");

const problems: string[] = [];
const rows = await waitForRows(sidecar);

if (!existsSync(sidecar)) {
  fail(
    `No sidecar at ${sidecar}. Check that bun run pack ran, the running server reloaded the plugin (opencode2 reload), and sidecarDir is ${sidecarDir}.`,
  );
}
console.log(`PASS sidecar ${sidecar}`);

if (rows.user === undefined) {
  problems.push("no user row containing pong");
} else {
  console.log(`PASS user row ${rows.user.entryId}: ${JSON.stringify(rows.user.text)}`);
}
if (rows.assistant === undefined) {
  problems.push("no assistant row containing pong");
} else {
  console.log(
    `PASS assistant row ${rows.assistant.entryId}: ${JSON.stringify(rows.assistant.text)}`,
  );
}

assertMode(sidecarDir, 0o700, "sidecar dir", problems);
assertMode(sidecar, 0o600, "database", problems);
const sideFiles: ReadonlyArray<readonly [string, string]> = [
  ["-wal", "wal"],
  ["-shm", "shm"],
];
for (const [suffix, label] of sideFiles) {
  const path = `${sidecar}${suffix}`;
  if (existsSync(path)) assertMode(path, 0o600, label, problems);
}

if (problems.length > 0) {
  fail(
    `Smoke failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nSidecar kept at ${sidecar} for inspection.`,
  );
}

if (args.keep) {
  console.log(`Kept sidecar at ${sidecar}`);
} else {
  removeSidecar(sidecar);
  console.log("Removed the smoke sidecar");
}
console.log("PASS opencode-lossless live smoke");
