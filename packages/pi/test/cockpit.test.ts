import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { test } from "vite-plus/test";

import { LcmCockpit, type CockpitDeps } from "../src/ui/cockpit.ts";
import { cycle, parseLcmConfig, readLcmConfig, writeLcmConfig } from "../src/ui/config-io.ts";
const theme = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

function makeDeps(overrides?: Partial<CockpitDeps>): {
  deps: CockpitDeps;
  config: Record<string, unknown>;
  patches: Array<Record<string, unknown>>;
} {
  const config: Record<string, unknown> = { softRatio: 0.7 };
  const patches: Array<Record<string, unknown>> = [];
  const deps: CockpitDeps = {
    getConfig: () => config as never,
    patchConfig: (p) => {
      Object.assign(config, p);
      patches.push(p);
    },
    getStats: () => ({ messages: 42, summaries: 3, dbBytes: 2048 }),
    getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000 }),
    getSessionLabel: () => "session-abc.jsonl",
    getModels: () => ["openrouter/z-ai/glm-5.3-flash", "cursor/claude-fable-5-1-xhigh"],
    onBackup: () => {},
    onClearCache: () => {},
    onDoctor: () => {},
    onResetDefaults: () => {},
    ...overrides,
  };
  return { deps, config, patches };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

test("config-io: cycle walks forward and backward with wrap", () => {
  const list = [10, 20, 30] as const;
  assert.equal(cycle(list, 10, 1), 20);
  assert.equal(cycle(list, 30, 1), 10);
  assert.equal(cycle(list, 10, -1), 30);
  assert.equal(cycle(list, 999 as never, 1), 10);
});

test("config-io: write/read round trip", () => {
  const origHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), "lcm-cfg-"));
  process.env.HOME = dir;
  try {
    writeLcmConfig({ summarizer: "a/b", swapAtRatio: 0.5 });
    assert.ok(existsSync(join(dir, ".pi", "agent", "lcm.json")));
    const { config: back, problems } = readLcmConfig();
    assert.deepEqual(problems, []);
    assert.equal(back.summarizer, "a/b");
    assert.equal(back.swapAtRatio, 0.5);
  } finally {
    process.env.HOME = origHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

function withTempHome(fn: (cfgPath: string, dir: string) => void): void {
  const origHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), "lcm-cfg-"));
  process.env.HOME = dir;
  try {
    fn(join(dir, ".pi", "agent", "lcm.json"), dir);
  } finally {
    process.env.HOME = origHome;
    try {
      chmodSync(join(dir, ".pi", "agent"), 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config-io: a deduped summarizer entry is a note, not a rejected config", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ summarizer: ["a/b", "a/b", "c/d"] }), "utf8");
    const { config, problems } = readLcmConfig();
    assert.deepEqual(config, { summarizer: ["a/b", "c/d"] });
    assert.deepEqual(problems, ['summarizer[1] repeats "a/b"; entry dropped']);
    assert.ok(!existsSync(`${cfgPath}.corrupt`));
  });
});

test("config-io: a corrupt lcm.json yields defaults and survives the next write as a backup", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    const corrupt = '{ "summarizer": "a/b", // comments are not JSON\n';
    writeFileSync(cfgPath, corrupt, "utf8");
    const { config, problems } = readLcmConfig();
    assert.deepEqual(config, {});
    assert.equal(readFileSync(cfgPath, "utf8"), corrupt);
    assert.deepEqual(problems, [
      `is corrupt, using defaults; original saved to ${cfgPath}.corrupt`,
    ]);
    writeLcmConfig({ swapAtRatio: 0.5 });
    assert.equal(readFileSync(`${cfgPath}.corrupt`, "utf8"), corrupt);
    assert.deepEqual(readLcmConfig().config, { swapAtRatio: 0.5 });
  });
});

test("config-io: parseLcmConfig keeps typed fields and names the dropped ones", () => {
  const parsed = parseLcmConfig({
    swapAtRatio: "0.7",
    recutAtRatio: 0.85,
    keepRecentTokens: null,
    maxAsyncChunks: Number.NaN,
    redactSecrets: "yes",
    assemblyEnabled: false,
    summarizer: 42,
    zones: {
      "a/b": { smartZone: 110_000, swapAtRatio: "x" },
      "c/d": 7,
      "e/f": { swapAtToknes: 100 },
      "g/h": { recutAtRatio: "0.9" },
    },
    typoKey: 1,
  });
  assert.deepEqual(parsed.config, {
    recutAtRatio: 0.85,
    assemblyEnabled: false,
    zones: { "a/b": { smartZone: 110_000 } },
  });
  assert.deepEqual(parsed.dropped, [
    "swapAtRatio (wrong type)",
    "keepRecentTokens (wrong type)",
    "maxAsyncChunks (wrong type)",
    "redactSecrets (wrong type)",
    "summarizer (wrong type)",
    "zones.a/b.swapAtRatio (wrong type)",
    "zones.c/d (not an object)",
    "zones.e/f.swapAtToknes (unknown key)",
    "zones.g/h.recutAtRatio (wrong type)",
    "typoKey (unknown key)",
  ]);
  assert.deepEqual(parseLcmConfig({ zones: { "p/m": { swapAtToknes: 100 } } }), {
    config: {},
    dropped: ["zones.p/m.swapAtToknes (unknown key)"],
    notes: [],
  });
  assert.deepEqual(parseLcmConfig([1, 2]), {
    config: {},
    dropped: ["(root is not an object)"],
    notes: [],
  });
  assert.deepEqual(parseLcmConfig({ swapAtRatio: 0.6 }), {
    config: { swapAtRatio: 0.6 },
    dropped: [],
    notes: [],
  });
});

test("config-io: summarizer accepts a chain, dedupes it, and names bad entries", () => {
  const parsed = parseLcmConfig({ summarizer: ["a/b", " c/d ", "a/b", "", 7, "auto"] });
  assert.deepEqual(parsed.config, { summarizer: ["a/b", "c/d", "auto"] });
  assert.deepEqual(parsed.dropped, ["summarizer[4] (wrong type)"]);
  assert.deepEqual(parsed.notes, [
    'summarizer[2] repeats "a/b"; entry dropped',
    "summarizer[3] is empty; entry dropped",
  ]);
});

test("config-io: a one entry chain collapses, an unusable one is a note", () => {
  assert.deepEqual(parseLcmConfig({ summarizer: ["a/b"] }), {
    config: { summarizer: "a/b" },
    dropped: [],
    notes: [],
  });
  assert.deepEqual(parseLcmConfig({ summarizer: [] }), {
    config: {},
    dropped: [],
    notes: ["summarizer has no usable entries; the session model is used"],
  });
  assert.deepEqual(parseLcmConfig({ summarizer: "   " }), {
    config: {},
    dropped: [],
    notes: ["summarizer is empty; the session model is used"],
  });
});

test("config-io: a mistyped field in lcm.json is ignored and backed up before the next write drops it", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    const text = '{ "swapAtRatio": "0.7", "summaryTokens": 1200 }\n';
    writeFileSync(cfgPath, text, "utf8");
    const { config, problems } = readLcmConfig();
    assert.deepEqual(config, { summaryTokens: 1200 });
    assert.equal(readFileSync(cfgPath, "utf8"), text);
    assert.deepEqual(problems, [
      `ignored swapAtRatio (wrong type); defaults apply; original saved to ${cfgPath}.corrupt`,
    ]);
    assert.equal(readFileSync(`${cfgPath}.corrupt`, "utf8"), text);
  });
});

test("config-io: an out-of-range field is ignored, named with its range, and backed up too", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    const text = '{ "summaryTokens": 0, "swapAtRatio": 0.7 }\n';
    writeFileSync(cfgPath, text, "utf8");
    const { config, problems } = readLcmConfig();
    assert.deepEqual(config, { swapAtRatio: 0.7 });
    assert.equal(readFileSync(cfgPath, "utf8"), text);
    assert.deepEqual(problems, [
      `ignored summaryTokens (out of range); defaults apply; original saved to ${cfgPath}.corrupt`,
    ]);
    assert.equal(readFileSync(`${cfgPath}.corrupt`, "utf8"), text);
  });
});

test("config-io: an existing backup is not clobbered by the next one", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(`${cfgPath}.corrupt`, "first backup", "utf8");
    writeFileSync(cfgPath, "not json", "utf8");
    assert.deepEqual(readLcmConfig().config, {});
    assert.equal(readFileSync(`${cfgPath}.corrupt`, "utf8"), "first backup");
    const extra = readdirSync(dirname(cfgPath)).filter((f) => /^lcm\.json\.corrupt\.\d+$/.test(f));
    assert.equal(extra.length, 1);
    assert.equal(readFileSync(join(dirname(cfgPath), extra[0]!), "utf8"), "not json");
  });
});

test("config-io: a backup that cannot be written still yields defaults instead of throwing at load", () => {
  withTempHome((cfgPath) => {
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, "not json", "utf8");
    mkdirSync(`${cfgPath}.corrupt`);
    const realNow = Date.now;
    Date.now = () => 42;
    mkdirSync(`${cfgPath}.corrupt.42`);
    try {
      const { problems } = readLcmConfig();
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /^is corrupt, using defaults; backup failed \(/);
    } finally {
      Date.now = realNow;
    }
    assert.equal(readFileSync(cfgPath, "utf8"), "not json");
  });
});

test("config-io: missing lcm.json reads as {} without creating the file", () => {
  withTempHome((cfgPath) => {
    assert.deepEqual(readLcmConfig().config, {});
    assert.equal(existsSync(cfgPath), false);
  });
});

test("config-io: write is atomic (no tmp left behind) and owner-only", () => {
  withTempHome((cfgPath) => {
    writeLcmConfig({ swapAtRatio: 0.6 });
    assert.equal(existsSync(`${cfgPath}.tmp`), false);
    assert.deepEqual(readdirSync(dirname(cfgPath)), ["lcm.json"]);
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(cfgPath, "utf8"), '{\n  "swapAtRatio": 0.6\n}\n');
  });
});

test("config-io: an overwrite keeps the first version it replaced", () => {
  withTempHome((cfgPath) => {
    writeLcmConfig({ swapAtRatio: 0.6 });
    assert.equal(existsSync(`${cfgPath}.bak`), false, "the first write replaced nothing");
    writeLcmConfig({ swapAtRatio: 0.9 });
    assert.deepEqual(JSON.parse(readFileSync(`${cfgPath}.bak`, "utf8")), { swapAtRatio: 0.6 });
    writeLcmConfig({ swapAtRatio: 0.95 });
    assert.deepEqual(
      JSON.parse(readFileSync(`${cfgPath}.bak`, "utf8")),
      { swapAtRatio: 0.6 },
      "a second write must not replace the backup an accident needs",
    );
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")), { swapAtRatio: 0.95 });
  });
});

test("config-io: a failed write leaves the previous file intact", () => {
  // Root ignores directory modes, so the case is skipped there and on Windows.
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  withTempHome((cfgPath) => {
    writeLcmConfig({ swapAtRatio: 0.6 });
    const before = readFileSync(cfgPath, "utf8");
    const dir = dirname(cfgPath);
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => writeLcmConfig({ swapAtRatio: 0.9 }));
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(readFileSync(cfgPath, "utf8"), before);
    assert.equal(existsSync(`${cfgPath}.tmp`), false);
  });
});

test("cockpit: renders telemetry, settings rows, and gauge", () => {
  const { deps } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  const lines = c.render(90);
  const text = lines.join("\n");
  assert.ok(text.includes("pi-lossless cockpit"));
  assert.ok(text.includes("42 msgs"));
  assert.ok(text.includes("3 summaries"));
  assert.ok(text.includes("per-turn assembly"));
  assert.ok(text.includes("70% of window"));
  assert.ok(text.includes("soft 70%"));
});

test("cockpit: down + right cycles swapAtRatio and persists via patchConfig", () => {
  const { deps, config, patches } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(RIGHT);
  assert.equal(config.swapAtRatio, 0.8);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], { swapAtRatio: 0.8 });
  c.handleInput(LEFT);
  assert.equal(config.swapAtRatio, 0.7);
});

test("cockpit: cycling the summarizer row onto a fallback writes a parseable chain", () => {
  const { deps, config } = makeDeps();
  config.summarizer = ["cursor/claude-fable-5-1-xhigh", "openrouter/z-ai/glm-5.3-flash"];
  const c = new LcmCockpit(deps, theme);
  for (let i = 0; i < 11; i++) c.handleInput(DOWN);
  c.handleInput(RIGHT);
  const reparsed = parseLcmConfig({ summarizer: config.summarizer });
  assert.deepEqual(reparsed.dropped, []);
  assert.deepEqual(reparsed.notes, []);
  assert.deepEqual(reparsed.config, { summarizer: "openrouter/z-ai/glm-5.3-flash" });
});

test("cockpit: smart-zone token rows cycle and disable back to ratio mode", () => {
  const { deps, config } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  assert.equal(config.swapAtTokens, undefined);
  c.handleInput(RIGHT);
  assert.equal(config.swapAtTokens, 50_000);
  c.handleInput(RIGHT);
  c.handleInput(RIGHT);
  c.handleInput(RIGHT);
  assert.equal(config.swapAtTokens, 110_000);
  c.handleInput(DOWN);
  assert.equal(config.smartZone, undefined);
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(RIGHT);
  assert.equal(config.recutAtTokens, 120_000);
  c.handleInput(LEFT);
  assert.equal(config.recutAtTokens, undefined);
});

test("cockpit: gauge labels soft threshold in tokens when swapAtTokens is set", () => {
  const { deps } = makeDeps({
    getConfig: () => ({ swapAtTokens: 110_000 }) as never,
  });
  const c = new LcmCockpit(deps, theme);
  const text = c.render(120).join("\n");
  assert.ok(text.includes("soft 110.0k tok"));
  assert.ok(!text.includes("soft 70%"));
});

test("cockpit: toggle flips assemblyEnabled with space", () => {
  const { deps, config } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  assert.equal(config.assemblyEnabled, undefined);
  c.handleInput(" ");
  assert.equal(config.assemblyEnabled, false);
  c.handleInput(" ");
  assert.equal(config.assemblyEnabled, true);
});

test("cockpit: a toggle row patches a boolean, a cycle row only its own values", () => {
  const { deps, config, patches } = makeDeps();
  const c = new LcmCockpit(deps, theme);

  c.handleInput(RIGHT);
  assert.equal(patches.length, 0, "a toggle row has no values to step through");
  c.handleInput(" ");
  assert.deepEqual(patches[0], { assemblyEnabled: false });
  assert.equal(typeof patches[0]!.assemblyEnabled, "boolean");

  c.handleInput(DOWN);
  c.handleInput(DOWN);
  const before = patches.length;
  c.handleInput(" ");
  assert.equal(patches.length, before, "space does not toggle a cycle row");
  const visited = new Set<number>();
  for (let i = 0; i < 8; i++) {
    c.handleInput(RIGHT);
    visited.add(config.swapAtRatio as number);
  }
  assert.deepEqual(
    [...visited].sort((a, b) => a - b),
    [0.5, 0.6, 0.7, 0.8, 0.9],
  );
});

test("cockpit: model row cycles through available models", () => {
  const { deps, config } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  for (let i = 0; i < 11; i++) c.handleInput(DOWN);
  assert.equal(config.summarizer, undefined);
  c.handleInput(RIGHT);
  assert.equal(config.summarizer, "openrouter/z-ai/glm-5.3-flash");
  c.handleInput(RIGHT);
  assert.equal(config.summarizer, "cursor/claude-fable-5-1-xhigh");
});

test("cockpit: a summarizer chain shows every entry and keeps its tail when cycled", () => {
  const { deps, config } = makeDeps();
  config.summarizer = ["a/one", "b/two"];
  const c = new LcmCockpit(deps, theme);
  for (let i = 0; i < 11; i++) c.handleInput(DOWN);
  assert.ok(c.render(200).join("\n").includes("a/one → b/two"));
  c.handleInput(RIGHT);
  assert.deepEqual(config.summarizer, ["openrouter/z-ai/glm-5.3-flash", "b/two"]);
});

test("cockpit: smart-zone easy knob clears the token pair and vice versa (OR-mode)", () => {
  const { deps, config } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  for (let i = 0; i < 4; i++) c.handleInput(DOWN);
  c.handleInput(RIGHT);
  assert.equal(config.smartZone, 120_000);
  assert.equal(config.swapAtTokens, undefined);
  assert.equal(config.recutAtTokens, undefined);
  c.handleInput(UP);
  c.handleInput(RIGHT);
  assert.equal(config.swapAtTokens, 50_000);
  assert.equal(config.smartZone, undefined);
  c.handleInput(DOWN);
  assert.equal(config.smartZone, undefined);
});

test("cockpit: active model zone renders exactly one override warning line", () => {
  const without = new LcmCockpit(makeDeps({ getActiveZone: () => undefined }).deps, theme).render(
    160,
  );
  const withZone = new LcmCockpit(
    makeDeps({ getActiveZone: () => "openrouter/z-ai/glm-5.3-flash" }).deps,
    theme,
  ).render(160);
  assert.equal(without.length, 20);
  assert.equal(withZone.length, 21);
  assert.equal(
    withZone[3],
    '⚠ thresholds overridden by zones["openrouter/z-ai/glm-5.3-flash"], so edits below write global config',
  );
  assert.deepEqual([...withZone.slice(0, 3), ...withZone.slice(4)], without);
});

test("cockpit: gauge labels soft threshold in tokens when smartZone is set", () => {
  const { deps } = makeDeps({
    getConfig: () => ({ smartZone: 110_000 }) as never,
  });
  const c = new LcmCockpit(deps, theme);
  const text = c.render(120).join("\n");
  assert.ok(text.includes("soft 110.0k tok"));
});

test("cockpit: b triggers backup, c clears cache, esc closes", () => {
  let backups = 0;
  let clears = 0;
  let closed = 0;
  const { deps } = makeDeps({
    onBackup: () => {
      backups++;
    },
    onClearCache: () => {
      clears++;
    },
  });
  const c = new LcmCockpit(deps, theme);
  c.onClose = () => closed++;
  c.handleInput("b");
  assert.equal(backups, 1);
  assert.ok(c.render(120).join("\n").includes("backing up…"));
  c.handleInput("c");
  assert.equal(clears, 1);
  c.handleInput("\x1b");
  assert.equal(closed, 1);
});

test("cockpit: gauge shows warning zone past soft threshold", () => {
  const { deps } = makeDeps({
    getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000 }),
  });
  const c = new LcmCockpit(deps, theme);
  const lines = c.render(100);
  assert.equal(lines[2], "context ███████████████████████████│·  95% · soft 70%");
});

test("cockpit: r reset requires double-press, then resets to defaults", () => {
  const { deps, config } = makeDeps();
  deps.patchConfig({ swapAtRatio: 0.3, keepRecentTokens: 2000, summarizer: "test/model" });
  let resets = 0;
  const counting: CockpitDeps = {
    ...deps,
    onResetDefaults: () => {
      resets++;
      Object.assign(config, { swapAtRatio: 0.7, keepRecentTokens: 20000, summarizer: undefined });
    },
  };
  const c2 = new LcmCockpit(counting, theme);
  c2.handleInput("r");
  assert.equal(resets, 0);
  const armed = c2.render(100).join("\n");
  assert.ok(armed.includes("press r again"));
  c2.handleInput("x");
  c2.handleInput("r");
  c2.handleInput("r");
  assert.equal(resets, 1);
  assert.equal(config.swapAtRatio, 0.7);
  assert.equal(config.keepRecentTokens, 20000);
  assert.equal(config.summarizer, undefined);
});

test("cockpit: render stays inside overlay width, no duplicate armed lines", () => {
  const { deps } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  c.handleInput("r");
  const lines = c.render(80);
  assert.equal(Math.max(...lines.map((l) => l.length)), 80);
  assert.deepEqual(
    lines.filter((l) => l.includes("press r again")),
    ["⚠ press r again to reset all settings to defaults (esc to cancel)"],
  );
  assert.equal(lines.at(-1), "⚠ press r again to reset all settings to defaults (esc to cancel)");
  assert.equal(lines[4], "❯ per-turn assembly  on  ␣ toggle");
  assert.equal(lines[5], "  redact secrets  on  ");
});

test("cockpit: esc while armed cancels only the confirmation, not the cockpit", () => {
  let closed = 0;
  const { deps, config } = makeDeps();
  const c = new LcmCockpit(deps, theme);
  c.onClose = () => closed++;
  c.handleInput("r");
  c.handleInput("\x1b");
  assert.equal(closed, 0);
  const lines = c.render(80).join("\n");
  assert.ok(!lines.includes("press r again"));
  c.handleInput(" ");
  assert.equal(config.assemblyEnabled, false);
  c.handleInput("\x1b");
  assert.equal(closed, 1);
});
