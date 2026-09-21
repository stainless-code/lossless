import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LcmStore } from "lossless-core";
import { openSessionStore } from "lossless-core";
import { EXPORT_VERSION } from "lossless-core";
import { appendMetric } from "lossless-core";
import { test } from "vite-plus/test";

import { registerLcmCommand, LCM_SUBCOMMANDS, type LcmCommandDeps } from "../src/ui/command.ts";
import type { LcmConfig } from "../src/ui/config-io.ts";

function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

interface Env {
  home: string;
  cwd: string;
  lcmDir: string;
  sessionsDir: string;
  restore: () => void;
}

function setupEnv(): Env {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), "lcm-cmd-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "lcm-cmd-cwd-"));
  const lcmDir = join(home, ".pi", "agent", "lcm");
  mkdirSync(lcmDir, { recursive: true });
  const sessionsDir = join(home, ".pi", "agent", "sessions");
  process.env.HOME = home;
  process.chdir(cwd);
  return {
    home,
    cwd,
    lcmDir,
    sessionsDir,
    restore: () => {
      process.env.HOME = origHome;
      process.chdir(origCwd);
    },
  };
}

function makeFakePi() {
  const commands = new Map<
    string,
    { description: string; handler: (args: string | undefined, ctx: unknown) => Promise<unknown> }
  >();
  const pi = {
    registerCommand: (name: string, def: { description: string; handler: never }) => {
      commands.set(name, def);
    },
  };
  return { pi: pi as never, commands };
}

function makeStoreWithMessage(path: string, entryId: string, text: string): LcmStore {
  const s = new LcmStore(path);
  s.insertMessage({ entryId, role: "user", text, tokens: 10, timestamp: Date.now() });
  return s;
}

function makeDeps(liveStore: LcmStore, lcmDir: string, config: LcmConfig = {}): LcmCommandDeps {
  return {
    getStore: () => liveStore,
    openStore: () => liveStore,
    getConfig: () => config,
    patchConfig: () => {},
    resetConfig: () => {},
    clearCommitState: () => {},
    getCommitState: () => null,
    getDbPath: (f) => (f ? join(lcmDir, `${hashPath(f)}.db`) : join(lcmDir, "scratch-cmd.db")),
    keepRecentTokens: () => 20_000,
  };
}

interface CtxOptions {
  model?: unknown;
  usage?: { tokens: number; contextWindow: number };
  find?: (provider: string, id: string) => unknown;
  levels?: string[];
  capture?: { component?: { handleInput(data: string): void } };
}

function makeCtx(sessionFile: string, notifications: string[], opts?: CtxOptions) {
  return {
    mode: "tui",
    sessionManager: { getSessionFile: () => sessionFile },
    getContextUsage: () => opts?.usage,
    model: opts?.model,
    modelRegistry: {
      find: opts?.find ?? (() => undefined),
      getAvailable: () => [],
    },
    ui: {
      notify: (msg: string, level?: string) => {
        notifications.push(msg);
        opts?.levels?.push(level ?? "");
      },
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: unknown,
        ) => { handleInput(data: string): void },
      ) => {
        if (opts?.capture) {
          opts.capture.component = factory(
            { requestRender: () => {} },
            { fg: (_c: string, s: string) => s, bold: (s: string) => s },
            {},
            () => {},
          );
        }
        return Promise.resolve(true);
      },
    },
  };
}

function bootstrap(opts?: { config?: LcmConfig } & CtxOptions) {
  const env = setupEnv();
  const livePath = join(env.sessionsDir, "sess-live.jsonl");
  mkdirSync(env.sessionsDir, { recursive: true });
  writeFileSync(livePath, "x", "utf8");
  const liveStore = new LcmStore(join(env.lcmDir, `${hashPath(livePath)}.db`));
  const fake = makeFakePi();
  registerLcmCommand(fake.pi as never, makeDeps(liveStore, env.lcmDir, opts?.config ?? {}));
  const notifications: string[] = [];
  const levels: string[] = [];
  const handler = (args: string | undefined) =>
    fake.commands.get("lcm")!.handler(args, makeCtx(livePath, notifications, { ...opts, levels }));
  return { env, liveStore, livePath, handler, notifications, levels };
}

test("command: migrate dry-runs the stale stores, and --apply upgrades them", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    const otherPath = join(env.sessionsDir, "sess-old.jsonl");
    const staleDb = join(env.lcmDir, `${hashPath(otherPath)}.db`);
    const stale = makeStoreWithMessage(staleDb, "o1", "history from an older build");
    stale.close();
    const raw = new DatabaseSync(staleDb);
    raw.exec("PRAGMA user_version = 0");
    raw.close();

    const opened = openSessionStore({
      hash: hashPath(otherPath),
      sessionFile: otherPath,
      storePath: staleDb,
      cwd: env.cwd,
      sessionId: "old",
      when: 0,
    });
    assert.deepEqual(
      opened,
      { kind: "skipped", reason: "older-generation" },
      "unreadable before the upgrade",
    );

    await handler("migrate");
    assert.ok(
      notifications.some(
        (n) => n.includes("1 store(s) older than generation") && n.includes("dry-run"),
      ),
      `dry run names the candidate: ${notifications.join(" | ")}`,
    );
    const stillStale = new DatabaseSync(staleDb);
    assert.equal(
      (stillStale.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      0,
      "a dry run writes nothing",
    );
    stillStale.close();

    notifications.length = 0;
    await handler("migrate --apply");
    assert.ok(
      notifications.some((n) => n.includes("upgraded 1 of 1 store(s)")),
      `apply reports the upgrade: ${notifications.join(" | ")}`,
    );
    const upgraded = openSessionStore({
      hash: hashPath(otherPath),
      sessionFile: otherPath,
      storePath: staleDb,
      cwd: env.cwd,
      sessionId: "old",
      when: 0,
    });
    assert.equal(upgraded.kind, "opened", "the store is searchable after the upgrade");
    if (upgraded.kind === "opened") {
      assert.equal(upgraded.store.grep("older build").length, 1);
      upgraded.store.close();
    }

    notifications.length = 0;
    await handler("migrate");
    assert.ok(
      notifications.some((n) => n.includes("nothing to do")),
      `a second run has nothing left: ${notifications.join(" | ")}`,
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: gc dry-run lists candidates without deleting", async () => {
  const { env, handler, notifications } = bootstrap();
  try {
    const gonePath = join(env.sessionsDir, "sess-gone.jsonl");
    const goneDb = join(env.lcmDir, `${hashPath(gonePath)}.db`);
    const gone = makeStoreWithMessage(goneDb, "g1", "orphan history line");
    gone.close();

    await handler("gc");

    assert.ok(notifications.some((n) => n.includes("1 removable DB(s)")));
    assert.ok(existsSync(goneDb), "dry run leaves the candidate in place");
  } finally {
    env.restore();
  }
});

test("command: gc --apply exports transcripts before deleting", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    const goneDb = join(env.lcmDir, "1111-gone.db");
    const goneStore = makeStoreWithMessage(goneDb, "g1", "ordinary history entry one");
    goneStore.close();
    const goneDb2 = join(env.lcmDir, "2222-gone.db");
    const goneStore2 = makeStoreWithMessage(goneDb2, "g2", "ordinary history entry two");
    goneStore2.close();
    const earlierExport = join(env.lcmDir, "lcm-export-gc-2026-01-01T00-00-00-000Z.jsonl");
    writeFileSync(earlierExport, "earlier run\n", "utf8");

    await handler("gc --apply");

    assert.ok(!existsSync(goneDb), "candidate 1 deleted");
    assert.ok(!existsSync(goneDb2), "candidate 2 deleted");
    const exports = readdirSync(env.lcmDir).filter((f) => f.startsWith("lcm-export-gc-"));
    assert.equal(
      exports.filter((f) => f !== basename(earlierExport)).length,
      1,
      "one new export file written beside the stores",
    );
    const written = exports.find((f) => f !== basename(earlierExport))!;
    const content = readFileSync(join(env.lcmDir, written), "utf8");
    assert.ok(content.includes("ordinary history entry one"));
    assert.ok(content.includes("ordinary history entry two"));
    assert.ok(
      readFileSync(earlierExport, "utf8") === "earlier run\n",
      "an earlier export is not collected as a store",
    );
    assert.equal(
      readdirSync(env.cwd).filter((f) => f.startsWith("lcm-export-gc-")).length,
      0,
      "nothing lands in the directory Pi was started from",
    );
    assert.ok(
      notifications.some((n) => n.includes("removed 2 of 2")),
      "success summary reported",
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: gc --apply keeps prior candidates' transcripts when a later store fails to open", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    const goneDb = join(env.lcmDir, "1111-gone.db");
    const goneStore = makeStoreWithMessage(goneDb, "g1", "survivor transcript line");
    goneStore.close();
    const garbageDb = join(env.lcmDir, "zzz-garbage.db");
    writeFileSync(garbageDb, Buffer.from("this is not a sqlite database file at all"));

    await handler("gc --apply");

    assert.ok(!existsSync(goneDb), "healthy candidate deleted");
    const exports = readdirSync(env.lcmDir).filter((f) => f.startsWith("lcm-export-gc-"));
    assert.equal(exports.length, 1, "export file written for the healthy candidate");
    const content = readFileSync(join(env.lcmDir, exports[0]!), "utf8");
    assert.ok(
      content.includes("survivor transcript line"),
      "transcript flushed to disk BEFORE its store was deleted",
    );
    assert.ok(existsSync(garbageDb), "failed candidate is left in place (no rollback)");
    assert.ok(notifications.some((n) => n.includes("removed 1 of 2")));
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: export writes JSONL of the full store", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    liveStore.insertMessage({
      entryId: "m1",
      role: "user",
      text: "exportable transcript content",
      tokens: 10,
      timestamp: Date.now(),
    });

    await handler("export out.jsonl");

    const exported = readFileSync(join(env.cwd, "out.jsonl"), "utf8");
    assert.ok(exported.includes("exportable transcript content"));
    assert.ok(notifications.some((n) => n.includes("LCM export: 1 messages")));
    assert.ok(
      notifications.some((n) => n.includes(resolve("out.jsonl"))),
      "the notify names the absolute path it wrote",
    );

    await handler("export");

    const defaulted = notifications.filter((n) => /→ \/[^→]*lcm-export-.*\.jsonl$/.test(n));
    assert.equal(defaulted.length, 1, "the default target is reported as an absolute path");
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: backup writes a timestamped copy next to the db", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    liveStore.insertMessage({
      entryId: "b1",
      role: "user",
      text: "backup me",
      tokens: 10,
      timestamp: Date.now(),
    });

    await handler("backup");

    const backups = readdirSync(env.lcmDir).filter((f) => f.includes(".backup-"));
    assert.equal(backups.length, 1, "one backup file created");
    assert.ok(notifications.some((n) => n.includes("LCM backup written")));
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: doctor prints one line per summary depth", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    for (const [entryId, text] of [
      ["e0", "a"],
      ["e1", "b"],
      ["e2", "c"],
    ] as const) {
      liveStore.insertMessage({ entryId, role: "user", text, tokens: 1, timestamp: 1 });
    }
    const leaf = (first: string, last: string, tokens: number) =>
      liveStore.insertSummary({
        kind: "leaf",
        text: "leaf",
        tokens,
        depth: 0,
        firstEntryId: first,
        lastEntryId: last,
      }).id;
    const l1 = leaf("e0", "e0", 1200);
    const l2 = leaf("e1", "e2", 1800);
    liveStore.insertSummary({
      kind: "condensed",
      text: "condensed",
      tokens: 900,
      depth: 1,
      firstEntryId: "e0",
      lastEntryId: "e2",
      childSummaryIds: [l1, l2],
    });

    await handler("doctor");

    const doctor = notifications.find((n) => n.startsWith("LCM doctor"));
    assert.ok(doctor, "doctor output present");
    assert.match(doctor, /messages: 3, summaries: 3,/);
    assert.match(doctor, /^ {2}depth 0 \(leaf\): 2 summaries, 3\.0k tokens total, 1\.5k avg$/m);
    assert.match(doctor, /^ {2}depth 1 \(condensed\): 1 summaries, 900 tokens total, 900 avg$/m);
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: doctor with no summaries prints no depth rows", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    await handler("doctor");
    const doctor = notifications.find((n) => n.startsWith("LCM doctor"));
    assert.ok(doctor);
    assert.match(
      doctor,
      /^messages: 0, summaries: 0, size: \d+ KB\nintegrity: 9 checks, no findings\npinned projection: none$/m,
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: unknown subcommand falls back to status summary", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    liveStore.insertMessage({
      entryId: "u1",
      role: "user",
      text: "whatever",
      tokens: 10,
      timestamp: Date.now(),
    });

    await handler("bogus");

    assert.ok(
      notifications.some((n) => n.includes("1 messages") && n.includes("0 summaries")),
      "fallback prints the status line",
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: doctor shows the resolved summarizer chain and its config", async () => {
  const { env, liveStore, handler, notifications, levels } = bootstrap({
    config: { summarizer: ["a/one", "ghost/x"] },
    model: { provider: "s", id: "session" },
    find: (p: string, i: string) =>
      p === "a" && i === "one" ? { provider: "a", id: "one" } : undefined,
  });
  try {
    await handler("doctor");

    const doctor = notifications.find((n) => n.startsWith("LCM doctor"));
    assert.ok(doctor, "doctor output present");
    assert.match(doctor, /^summarizer: a\/one → s\/session · config: a\/one, ghost\/x$/m);
    assert.match(doctor, /^⚠ summarizer model not found: ghost\/x; using a\/one → s\/session$/m);
    assert.equal(levels.at(-1), "warning");
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: doctor with no resolvable model says so and warns about nothing", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    await handler("doctor");

    const doctor = notifications.find((n) => n.startsWith("LCM doctor"));
    assert.ok(doctor);
    assert.match(doctor, /^summarizer: \(no model resolves\) · config: auto$/m);
    assert.ok(!doctor.includes("⚠"), "no substitution warning without an unresolved entry");
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: the cockpit d action carries the summarizer chain", async () => {
  const capture: { component?: { handleInput(data: string): void } } = {};
  const { env, liveStore, handler, notifications, levels } = bootstrap({
    config: { summarizer: "ghost/x" },
    model: { provider: "s", id: "session" },
    capture,
  });
  try {
    await handler("settings");
    assert.ok(capture.component, "the cockpit is built through ui.custom");

    capture.component.handleInput("d");

    const last = notifications.at(-1)!;
    assert.match(
      last,
      /^LCM doctor: 0 msgs, 0 summaries, \d+ KB, pinned projection no, assembly on$/m,
    );
    assert.match(last, /^summarizer: s\/session · config: ghost\/x$/m);
    assert.match(last, /^⚠ summarizer model not found: ghost\/x; using s\/session$/m);
    assert.equal(levels.at(-1), "warning");
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: import restores an exported file and refuses a foreign one", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    liveStore.insertMessage({
      entryId: "m1",
      role: "user",
      text: "history to hand over",
      tokens: 10,
      timestamp: 1,
    });
    await handler("export round-trip.jsonl");
    const exported = readFileSync(join(env.cwd, "round-trip.jsonl"), "utf8");

    await handler("import round-trip.jsonl");
    assert.ok(
      notifications.some((n) =>
        n.includes("0 messages and 0 summaries restored; 1 row already present"),
      ),
      notifications.join(" | "),
    );

    writeFileSync(join(env.cwd, "foreign.jsonl"), '{"hello":"world"}\n', "utf8");
    await handler("import foreign.jsonl");
    assert.ok(notifications.some((n) => n.includes("LCM import refused: line 1 has version")));

    assert.ok(JSON.parse(exported.split("\n")[0]!).v === EXPORT_VERSION);
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: doctor reports integrity, and --repair fixes what it can", async () => {
  const { env, liveStore, handler, notifications, levels } = bootstrap();
  try {
    liveStore.insertSummary({
      kind: "leaf",
      text: "a node nothing can reach",
      tokens: 3,
      depth: 0,
      firstEntryId: "ghost",
      lastEntryId: "ghost",
    });
    await handler("doctor");
    const before = notifications.find((n) => n.startsWith("LCM doctor"))!;
    assert.ok(before.includes("integrity: 9 checks, 2 finding(s)"), before);
    assert.ok(before.includes("summary-span: 1 x these summaries name an entry"), before);
    assert.ok(before.includes("    #1"), before);
    assert.ok(before.includes("summary-shape: 1 x 1 with a depth or provenance"), before);
    assert.equal(levels.at(-1), "warning", "a violation raises the notification level");

    notifications.length = 0;
    await handler("doctor --repair");
    const after = notifications.find((n) => n.startsWith("LCM doctor"))!;
    assert.ok(
      after.includes("repair: rebuilt the full-text index (0 row(s) from messages)"),
      after,
    );
    assert.ok(after.includes("repair: dropped 1 summar(y|ies) with an unresolvable span"), after);
    assert.ok(after.includes("integrity: 9 checks, no findings"), after);
    assert.equal(levels.at(-1), "info");
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: diagnose pastes one bundle, with no stored text and no home path", async () => {
  const { env, liveStore, livePath, handler, notifications, levels } = bootstrap({
    usage: { tokens: 60_000, contextWindow: 200_000 },
  });
  try {
    const tag = `${hashPath(livePath)}.db`;
    liveStore.insertMessage({
      entryId: "e-canary",
      role: "user",
      text: "CANARY-MESSAGE-TEXT in a message body",
      tokens: 10,
      timestamp: Date.now(),
    });
    liveStore.insertSummary({
      kind: "leaf",
      text: "CANARY-SUMMARY-TEXT in a node",
      tokens: 3,
      depth: 0,
      firstEntryId: "e-canary",
      lastEntryId: "e-canary",
    });
    appendMetric({
      event: "lcm",
      kind: "summarizer-error",
      session: tag,
      level: 1,
      sourceChars: 40,
      reason: "threw",
      category: "auth",
      error: `provider rejected the key sk-${"A".repeat(20)}`,
    });

    await handler("diagnose");
    const bundle = notifications.find((n) => n.startsWith("LCM diagnose bundle"))!;
    assert.ok(bundle, notifications.join(" | "));
    assert.ok(!bundle.includes("CANARY-MESSAGE-TEXT"), bundle);
    assert.ok(!bundle.includes("CANARY-SUMMARY-TEXT"), bundle);
    assert.ok(!bundle.includes(env.home), bundle);
    assert.ok(!bundle.includes("/Users/"), bundle);
    assert.ok(bundle.includes("config (~/.pi/agent/lcm.json):"), bundle);
    assert.match(
      bundle,
      /^LCM diagnose bundle: pi-lossless \d+\.\d+\.\d+, pi \d+\.\d+\.\d+, node v/m,
    );
    assert.ok(bundle.includes(`session: store ${tag},`), bundle);
    assert.ok(bundle.includes("messages: 1, summaries: 1,"), bundle);
    assert.ok(bundle.includes("metrics: 1 row(s) for this session, 1 shown, 0 not shown"), bundle);
    assert.ok(bundle.includes(`"session":"${tag}"`), bundle);
    assert.ok(!bundle.includes(`sk-${"A".repeat(20)}`), bundle);
    assert.ok(bundle.includes("[REDACTED]"), bundle);
    assert.equal(levels.at(-1), "warning");
    assert.ok(Buffer.byteLength(bundle, "utf8") < 8192, String(bundle.length));
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: diagnose --save writes the bytes it would notify, in a file at mode 0600", async () => {
  const { env, liveStore, livePath, handler, notifications, levels } = bootstrap({
    usage: { tokens: 60_000, contextWindow: 200_000 },
  });
  try {
    const tag = `${hashPath(livePath)}.db`;
    liveStore.insertMessage({
      entryId: "e-save",
      role: "user",
      text: "CANARY-MESSAGE-TEXT is not for a file either",
      tokens: 10,
      timestamp: Date.now(),
    });
    liveStore.insertSummary({
      kind: "leaf",
      text: "CANARY-SUMMARY-TEXT in a node",
      tokens: 3,
      depth: 0,
      firstEntryId: "ghost",
      lastEntryId: "ghost",
    });
    appendMetric({
      event: "lcm",
      kind: "summarizer-error",
      session: tag,
      level: 1,
      sourceChars: 40,
      reason: "threw",
      category: "auth",
      error: `provider rejected the key sk-${"A".repeat(20)}`,
    });

    await handler("diagnose");
    const notified = notifications.find((n) => n.startsWith("LCM diagnose bundle"))!;
    assert.ok(notified, notifications.join(" | "));

    notifications.length = 0;
    await handler("diagnose --save lcm-diagnose.txt");
    const target = join(env.cwd, "lcm-diagnose.txt");
    const written = readFileSync(target, "utf8");
    assert.equal(written, `${notified}\n`);
    assert.equal(
      notifications.length,
      1,
      `the block is not also notified: ${notifications.join(" | ")}`,
    );
    assert.equal(
      notifications[0],
      `LCM diagnose: wrote ${Buffer.byteLength(notified, "utf8")} bytes to lcm-diagnose.txt (mode 0600); the block is in the file, not in this notification.`,
    );
    assert.ok(!written.includes("CANARY-MESSAGE-TEXT"), written);
    assert.ok(!written.includes("CANARY-SUMMARY-TEXT"), written);
    assert.ok(!written.includes(env.home), written);
    assert.ok(!written.includes(`sk-${"A".repeat(20)}`), written);
    assert.ok(written.includes("[REDACTED]"), written);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(levels.at(-1), "warning", "the save confirmation carries the violation");

    notifications.length = 0;
    await handler("diagnose --save=second.txt");
    assert.equal(readFileSync(join(env.cwd, "second.txt"), "utf8"), written);
    assert.ok(!notifications.some((n) => n.startsWith("LCM diagnose bundle")));
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: diagnose --save names what it needs, and a path it cannot write is not fatal", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    await handler("diagnose --save");
    assert.deepEqual(notifications, [
      "LCM diagnose --save: name the file to write, e.g. `/lcm diagnose --save lcm-diagnose.txt`.",
    ]);
    assert.deepEqual(readdirSync(env.cwd), [], "a flag with no path writes nothing");

    notifications.length = 0;
    await handler("diagnose --save no/such/dir/out.txt");
    assert.equal(notifications.length, 1, notifications.join(" | "));
    assert.match(notifications[0]!, /^LCM diagnose: cannot write no\/such\/dir\/out\.txt \(/);
    assert.ok(!notifications[0]!.startsWith("LCM diagnose bundle"));
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: every advertised subcommand has a branch, and none falls through", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    for (const sub of LCM_SUBCOMMANDS) {
      notifications.length = 0;
      await handler(sub);
      if (sub !== "settings") {
        assert.ok(notifications.length > 0, `${sub} produced no notification`);
      }
      assert.ok(
        !notifications.some((n) => / KB in /.test(n)),
        `${sub} fell through to the generic notice: ${notifications.join(" | ")}`,
      );
    }
    notifications.length = 0;
    await handler("nonsense");
    assert.ok(
      notifications.some((n) => / KB in /.test(n)),
      notifications.join(" | "),
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: status shows a corrected window beside Pi's belief", async () => {
  const { env, liveStore, handler, notifications } = bootstrap({
    usage: { tokens: 60_000, contextWindow: 400_000 },
    model: { provider: "test", id: "test-model" },
  });
  try {
    // A provider stated the real window on an earlier turn. The turn's own
    // occupancy still reads Pi's belief here, so the line has to show both
    // numbers rather than silently replacing one with the other.
    liveStore.setModelWindow("test/test-model", 200_000, "provider-error");
    await handler("status");
    assert.match(
      notifications.at(-1)!,
      /^window: Pi believes 400\.0k, corrected to 200\.0k \(provider-error\)$/m,
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: status reports the projection, not just the store counts", async () => {
  const { env, liveStore, handler, notifications } = bootstrap({
    usage: { tokens: 60_000, contextWindow: 200_000 },
  });
  try {
    await handler("status");
    const status = notifications.at(-1)!;
    assert.match(
      status,
      /^LCM: 0 messages, 0 summaries, \d+ KB\nprojection: none\ncontext: 30% of 200\.0k\nthresholds: swap 70% \/ recut 85%\nwindow: 200\.0k \(Pi's belief, uncorrected\)$/m,
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});

test("command: status says what it cannot know instead of guessing", async () => {
  const { env, liveStore, handler, notifications } = bootstrap();
  try {
    await handler("status");
    assert.equal(
      notifications.at(-1),
      `LCM: 0 messages, 0 summaries, ${(liveStore.stats().dbBytes / 1024).toFixed(0)} KB\n` +
        "projection: none\ncontext: unknown\nthresholds: window unknown\n" +
        "window: unknown (Pi's belief, uncorrected)",
    );
    liveStore.close();
  } finally {
    env.restore();
  }
});
