import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BUNDLE,
  PLUGIN_DIST,
  fail,
  findPluginBinding,
  isRecord,
  opencodeConfigPath,
  openStore,
  readConfig,
  requireBundle,
  resolveSidecarDir,
  sanitizeSessionId,
} from "./opencode-config.ts";

type Mode = "manual" | "auto";

interface Args {
  mode: Mode;
  model: string | undefined;
  keep: boolean;
  timeoutMs: number;
}

interface CompactionRows {
  readonly marks: string[];
  readonly summaries: ReadonlyArray<{ readonly entryId: string; readonly text: string }>;
}

const POLL_TIMEOUT_MS = 30_000;
const PROMPT_PONG = "Reply with exactly: pong.";
const FALLBACK_MODEL = "opencode-go/deepseek-v4.1-flash";
const FILLER_LINES = 800;
const MANUAL = "compaction summary (manual)";
const AUTO = "compaction summary (auto)";

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "manual", model: undefined, keep: false, timeoutMs: 240_000 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=");
    const next = (): string => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--mode": {
        const mode = next();
        if (mode !== "manual" && mode !== "auto") fail("--mode takes manual or auto.");
        args.mode = mode;
        break;
      }
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

/** The provider and bare model id the project-scoped config keys its limit
 * under. A model without a provider cannot name that entry. */
function modelParts(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) fail(`Model ${model} has no provider prefix; expected provider/model[#variant].`);
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1).split("#")[0]!;
  if (id.length === 0) fail(`Model ${model} names no model after the provider.`);
  return { provider, id };
}

function runOpencode(args: string[], cwd: string, timeoutMs: number, label: string): void {
  // The host resolves the session directory from PWD, not the process cwd, so
  // a temp project config applies only when PWD names that directory too.
  const env = { ...process.env, PWD: cwd };
  const result = spawnSync("opencode2", args, { cwd, env, encoding: "utf8", timeout: timeoutMs });
  if (result.error) fail(`${label} could not complete: ${result.error.message}`);
  if (result.signal !== null) {
    fail(
      `${label} was killed by ${result.signal} after ${timeoutMs}ms.\nstdout: ${result.stdout.trim()}\nstderr: ${result.stderr.trim()}`,
    );
  }
  if (result.status !== 0) {
    fail(
      `${label} exited ${result.status}.\nstdout: ${result.stdout.trim()}\nstderr: ${result.stderr.trim()}`,
    );
  }
}

function compactSession(sessionId: string, timeoutMs: number, cwd: string): void {
  runOpencode(
    ["api", "session.compact", `--param`, `sessionID=${sessionId}`, "-d", "{}"],
    cwd,
    timeoutMs,
    "opencode2 api session.compact",
  );
}

function reloadHost(timeoutMs: number, cwd: string): void {
  runOpencode(["reload"], cwd, timeoutMs, "opencode2 reload");
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

function readCompactionRows(path: string): CompactionRows {
  const db = openStore(path);
  const marks: string[] = [];
  const summaries: Array<{ entryId: string; text: string }> = [];
  try {
    for (const row of db
      .prepare(
        "SELECT entry_id FROM messages WHERE instr(entry_id, ':compaction:') > 0 ORDER BY rowid ASC",
      )
      .all()) {
      if (isRecord(row) && typeof row.entry_id === "string") marks.push(row.entry_id);
    }
    for (const row of db
      .prepare(
        "SELECT entry_id, text FROM messages WHERE instr(entry_id, ':summary:') > 0 ORDER BY rowid ASC",
      )
      .all()) {
      if (isRecord(row) && typeof row.entry_id === "string" && typeof row.text === "string") {
        summaries.push({ entryId: row.entry_id, text: row.text });
      }
    }
  } finally {
    db.close();
  }
  return { marks, summaries };
}

function describeRows(rows: CompactionRows): string {
  const marks = rows.marks.length === 0 ? "none" : rows.marks.join(", ");
  const summaries =
    rows.summaries.length === 0 ? "none" : rows.summaries.map((row) => row.entryId).join(", ");
  return `marks: ${marks}\nsummaries: ${summaries}`;
}

async function poll(
  sidecar: string,
  label: string,
  check: (rows: CompactionRows) => boolean,
): Promise<CompactionRows> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (existsSync(sidecar)) {
      const rows = readCompactionRows(sidecar);
      if (check(rows)) return rows;
    }
    if (Date.now() >= deadline) {
      const rows = existsSync(sidecar) ? readCompactionRows(sidecar) : { marks: [], summaries: [] };
      fail(
        `Timed out after ${POLL_TIMEOUT_MS}ms waiting for ${label} in ${sidecar}.\n${describeRows(rows)}\nSidecar kept for inspection.`,
      );
    }
    await sleep(250);
  }
}

function removeSidecar(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(file, { force: true });
  }
}

/** A deterministic passage long enough to cross a 6k-token window. */
function fillerPrompt(): string {
  const lines: string[] = [];
  for (let i = 0; i < FILLER_LINES; i++) {
    lines.push(
      `Note ${i + 1}: the passage narrows near the shoals and the current turns west at dusk.`,
    );
  }
  return `${lines.join("\n")}\n\nSummarize the passage notes in one word.`;
}

const args = parseArgs(process.argv.slice(2));
requireBundle();

const configPath = opencodeConfigPath();
if (!existsSync(configPath)) fail(`No OpenCode config at ${configPath}.`);
const config = readConfig(configPath);
const binding = findPluginBinding(config, configPath, PLUGIN_DIST);
if (!binding) fail(`${configPath} has no plugins entry pointing at ${PLUGIN_DIST}.`);

const model =
  args.mode === "auto"
    ? (args.model ?? FALLBACK_MODEL)
    : (args.model ?? configuredModel(config) ?? FALLBACK_MODEL);
const sidecarDir = resolveSidecarDir(binding.sidecarDir);
const sessionId = `ses_lossless_compaction_${Date.now()}`;
const sidecar = join(sidecarDir, `${sanitizeSessionId(sessionId)}.sqlite`);
// The temp project stays in place: the shared server keeps the location
// registered, and removing it fails the next `opencode2 reload`. The OS temp
// directory cleans it up.
const cwd = mkdtempSync(join(tmpdir(), "opencode-lossless-compact-"));

console.log(`OpenCode config: ${configPath}`);
console.log(`Plugin bundle: ${BUNDLE}`);
console.log(`Sidecar dir: ${sidecarDir}`);
console.log(`Session: ${sessionId}`);
console.log(`Model: ${model}`);
console.log(`Mode: ${args.mode}`);
console.log(`Run cwd: ${cwd}`);

const problems: string[] = [];

if (args.mode === "manual") {
  runOpencode(
    ["run", "--session", sessionId, "-m", model, PROMPT_PONG],
    cwd,
    args.timeoutMs,
    "opencode2 run",
  );
  console.log("PASS initial run exited 0");

  compactSession(sessionId, args.timeoutMs, cwd);
  console.log("PASS compaction requested through the API");

  runOpencode(
    ["run", "--session", sessionId, "-m", model, "Say done"],
    cwd,
    args.timeoutMs,
    "opencode2 run",
  );
  console.log("PASS step boundary run exited 0");

  const first = await poll(
    sidecar,
    "the first manual compaction mark and summary",
    (rows) => rows.marks.length >= 1 && rows.summaries.some((row) => row.text.includes(MANUAL)),
  );
  const firstMarks = [...first.marks];
  const firstSummaries = first.summaries.map((row) => row.entryId);
  for (const id of firstMarks) console.log(`PASS compaction mark ${id}`);
  for (const row of first.summaries) console.log(`PASS summary ${row.entryId}`);

  reloadHost(args.timeoutMs, cwd);
  console.log("PASS opencode2 reload exited 0");

  runOpencode(
    ["run", "--session", sessionId, "-m", model, "Say alpha"],
    cwd,
    args.timeoutMs,
    "opencode2 run",
  );
  console.log("PASS post-reload run exited 0");

  compactSession(sessionId, args.timeoutMs, cwd);
  console.log("PASS second compaction requested through the API");

  runOpencode(
    ["run", "--session", sessionId, "-m", model, "Say beta"],
    cwd,
    args.timeoutMs,
    "opencode2 run",
  );
  console.log("PASS second step boundary run exited 0");

  const second = await poll(
    sidecar,
    "a second manual compaction after the reload",
    (rows) =>
      rows.summaries.filter((row) => row.text.includes(MANUAL)).length >= 2 &&
      rows.summaries.some(
        (row) => row.text.includes(MANUAL) && !firstSummaries.includes(row.entryId),
      ),
  );
  console.log(`PASS compaction marks after reload: ${second.marks.length}`);
  console.log(`PASS summaries after reload: ${second.summaries.length}`);

  if (second.marks.length !== 2) {
    problems.push(`expected 2 compaction marks after the reload, found ${second.marks.length}`);
  }
  if (second.summaries.length !== 2) {
    problems.push(`expected 2 summaries after the reload, found ${second.summaries.length}`);
  }
  const allIds = [...second.marks, ...second.summaries.map((row) => row.entryId)];
  if (new Set(allIds).size !== allIds.length) {
    problems.push(`entry ids are not distinct: ${allIds.join(", ")}`);
  }
  for (const id of [...firstMarks, ...firstSummaries]) {
    if (!allIds.includes(id)) problems.push(`the row ${id} did not survive the reload`);
  }
} else {
  const parts = modelParts(model);
  const projectConfig = join(cwd, ".opencode", "opencode.json");
  mkdirSync(join(cwd, ".opencode"), { recursive: true });
  writeFileSync(
    projectConfig,
    `${JSON.stringify(
      {
        model,
        provider: {
          [parts.provider]: {
            models: { [parts.id]: { limit: { context: 6000, output: 1000 } } },
          },
        },
        compaction: { auto: true, keep: { tokens: 1000 }, buffer: 500 },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`PASS project config ${projectConfig}`);

  runOpencode(
    ["run", "--session", sessionId, "-m", model, fillerPrompt()],
    cwd,
    args.timeoutMs,
    "opencode2 run",
  );
  console.log("PASS filler run exited 0");

  const rows = await poll(
    sidecar,
    "an automatic compaction mark and summary",
    (candidate) =>
      candidate.marks.length >= 1 && candidate.summaries.some((row) => row.text.includes(AUTO)),
  );
  for (const id of rows.marks) console.log(`PASS compaction mark ${id}`);
  for (const row of rows.summaries) console.log(`PASS summary ${row.entryId}`);
  if (!rows.summaries.some((row) => row.text.includes(AUTO))) {
    problems.push(`no summary carried ${JSON.stringify(AUTO)}`);
  }
}

assertMode(sidecarDir, 0o700, "sidecar dir", problems);
assertMode(sidecar, 0o600, "database", problems);
for (const [suffix, label] of [
  ["-wal", "wal"],
  ["-shm", "shm"],
] as const) {
  const path = `${sidecar}${suffix}`;
  if (existsSync(path)) assertMode(path, 0o600, label, problems);
}

if (problems.length > 0) {
  fail(
    `Compaction gate failed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nSidecar kept at ${sidecar} for inspection.`,
  );
}

// The temp project stays in place: the shared server keeps the location
// registered, and removing it fails the next `opencode2 reload`. The OS temp
// directory cleans it up.
if (args.keep) {
  console.log(`Kept sidecar at ${sidecar}`);
} else {
  removeSidecar(sidecar);
  console.log("Removed the compaction sidecar");
}
console.log(`PASS opencode-lossless compaction (${args.mode})`);
