import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { LcmStore, ingestEntries } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import type { CommandInvocation } from "../src/host.ts";
import {
  backupCommand,
  diagnoseCommand,
  exportCommand,
  gcCommand,
  importCommand,
  migrateCommand,
  type LifecycleDeps,
} from "../src/lifecycle.ts";
import { Sidecars } from "../src/sidecars.ts";

const SESSION = "ses_lifecycle";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opencode-lossless-lifecycle-"));
}

function seed(sidecars: Sidecars, sessionID: string, text: string): void {
  const store = sidecars.for(sessionID);
  ingestEntries(store, [
    { entryId: `${sessionID}:prompt:msg_1`, role: "user", text, timestamp: 1 },
  ]);
}

function seedDetached(sidecars: Sidecars, sessionID: string, text: string): void {
  const store = new LcmStore(sidecars.pathFor(sessionID));
  try {
    ingestEntries(store, [
      { entryId: `${sessionID}:prompt:msg_1`, role: "user", text, timestamp: 1 },
    ]);
  } finally {
    store.close();
  }
}

function ageAll(sidecars: Sidecars, sessionID: string, date: Date): void {
  const base = sidecars.pathFor(sessionID);
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      utimesSync(path, date, date);
    } catch {}
  }
}

interface Harness {
  readonly dir: string;
  readonly sidecars: Sidecars;
  readonly deps: LifecycleDeps;
  readonly texts: string[];
  readonly records: Array<Record<string, unknown>>;
}

function harness(overrides: Partial<LifecycleDeps> = {}): Harness {
  const dir = tempDir();
  const sidecars = new Sidecars(dir);
  const texts: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const deps: LifecycleDeps = {
    sidecars,
    options: {
      assembly: true,
      swapAtRatio: 0.7,
      recutAtRatio: 0.85,
      keepRecentTokens: 20_000,
    },
    version: () => "opencode-lossless test",
    host: () => "opencode v2",
    prompt: (_sessionID, text) => {
      texts.push(text);
      return Promise.resolve(undefined);
    },
    record: (row) => {
      records.push(row);
    },
    heal: async () => {
      throw new Error("heal is not scripted in this harness");
    },
    ...overrides,
  };
  return { dir, sidecars, deps, texts, records };
}

async function run(
  command: (deps: LifecycleDeps) => { execute(input: CommandInvocation): Promise<void> },
  harnessValue: Harness,
  text: string,
  sessionID = SESSION,
): Promise<string> {
  await command(harnessValue.deps).execute({
    sessionID,
    prompt: { text },
    delivery: {},
  });
  return harnessValue.texts[harnessValue.texts.length - 1] ?? "";
}

describe("lifecycle commands", () => {
  it("writes a backup beside the sidecar", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the northern passage");
      const text = await run(backupCommand, h, "/lossless-backup");
      expect(text).toContain("LCM backup written");
      const backup = readdirSync(h.dir).find((name) => name.includes(".sqlite.backup-"));
      expect(backup).toBeDefined();
      expect(readFileSync(join(h.dir, backup!)).length).toBeGreaterThan(0);
    } finally {
      h.sidecars.close();
    }
  });

  it("exports JSONL and imports it into an empty sidecar", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the southern harbor");
      const exportText = await run(exportCommand, h, "/lossless-export");
      const target = /-> (.+) \(mode 0600\)/.exec(exportText)?.[1];
      expect(target).toBeDefined();
      const body = readFileSync(target!, "utf8");
      expect(body).toContain("the southern harbor");
      expect(statSync(target!).mode & 0o777).toBe(0o600);

      const importText = await run(importCommand, h, `/lossless-import ${target}`, "ses_import");
      expect(importText).toContain("1 messages inserted");
      const imported = new LcmStore(h.sidecars.pathFor("ses_import"), { queryOnly: true });
      try {
        expect(imported.stats().messages).toBe(1);
      } finally {
        imported.close();
      }
    } finally {
      h.sidecars.close();
    }
  });

  it("diagnoses with a redacted bundle and the model window", async () => {
    const h = harness({
      model: () => Promise.resolve({ providerID: "test", id: "model" }),
      window: () => Promise.resolve(100_000),
    });
    try {
      seed(h.sidecars, SESSION, "the eastern tide");
      const missing = await run(diagnoseCommand, h, "/lossless-diagnose --save");
      expect(missing).toContain("--save");

      const text = await run(diagnoseCommand, h, "/lossless-diagnose --repair");
      expect(text).toContain("LCM diagnose bundle");
      expect(text).toContain("messages: 1");
      const [first, ...rest] = text.split("\n");
      const home = homedir();
      const maskedDir =
        h.dir === home || h.dir.startsWith(`${home}/`) ? `~${h.dir.slice(home.length)}` : "<path>";
      expect(first).toBe(`sidecar: ${maskedDir} (explicit)`);
      expect(rest.join("\n")).not.toContain(h.dir);
      expect(text).toContain("model: test/model, window: 100.0k");
      expect(text).toContain("rebuilt the full-text index");
    } finally {
      h.sidecars.close();
    }
  });

  it("diagnoses an orphan sidecar with its path and never reports a live one", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seed(h.sidecars, "ses_live", "the live session");
      seedDetached(h.sidecars, "ses_old", "the old session");
      const oldPath = h.sidecars.pathFor("ses_old");
      const livePath = h.sidecars.pathFor("ses_live");
      const text = await run(diagnoseCommand, h, "/lossless-diagnose");
      expect(text).toContain("orphan-sidecar");
      expect(text).toContain("ses_old");
      expect(text).toContain(oldPath);
      expect(text).not.toContain(livePath);
    } finally {
      h.sidecars.close();
    }
  });

  it("after a restart names a retained but unopened sidecar as unopened, not sessionless", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_retained", "the retained session");
      h.sidecars.close();
      const fresh = new Sidecars(h.dir);
      try {
        const text = await run(
          diagnoseCommand,
          { ...h, deps: { ...h.deps, sidecars: fresh } },
          "/lossless-diagnose",
        );
        expect(text).toContain("orphan-sidecar");
        expect(text).toContain("ses_retained");
        expect(text).toContain("not open in this process");
        expect(text).not.toContain("no live session");
      } finally {
        fresh.close();
      }
    } finally {
      h.sidecars.close();
    }
  });

  it("reports a current schema as nothing to migrate", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the western reef");
      const text = await run(migrateCommand, h, "/lossless-migrate");
      expect(text).toContain("nothing to do");
    } finally {
      h.sidecars.close();
    }
  });

  it("gc lists an old sidecar and deletes it after export", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_old", "the old session");
      seed(h.sidecars, "ses_live", "the live session");
      const oldPath = h.sidecars.pathFor("ses_old");
      const old = new Date(0);
      utimesSync(oldPath, old, old);

      const dry = await run(gcCommand, h, "/lossless-gc --older-than 30");
      expect(dry).toContain("ses_old");
      expect(existsSync(oldPath)).toBe(true);

      const open = await run(gcCommand, h, "/lossless-gc --session ses_live --apply");
      expect(open).toContain("open in this process");

      const applied = await run(gcCommand, h, "/lossless-gc --older-than 30 --apply");
      expect(applied).toContain("removed 1 of 1");
      expect(existsSync(oldPath)).toBe(false);
      expect(existsSync(h.sidecars.pathFor(SESSION))).toBe(true);
      const exported = applied.split("exported to ")[1]?.replace(/\.$/u, "");
      expect(exported).toBeDefined();
      expect(readFileSync(exported!, "utf8")).toContain("the old session");
      expect(h.records.some((row) => row.kind === "gc" && row.action === "deleted")).toBe(true);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc grace skips a recently active store and lists an old one", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_old", "the old alpha");
      seedDetached(h.sidecars, "ses_gc_fresh", "the fresh beta");
      ageAll(h.sidecars, "ses_gc_old", new Date(0));
      ageAll(h.sidecars, "ses_gc_fresh", new Date(Date.now() - 30 * 60_000));

      const dry = await run(gcCommand, h, "/lossless-gc --older-than 0.01");
      expect(dry).toContain("ses_gc_old");
      expect(dry).toContain("Skipped 1 sidecar(s) active within the last 60 minute(s)");
      expect(dry).toContain("ses_gc_fresh");
      expect(existsSync(h.sidecars.pathFor("ses_gc_old"))).toBe(true);
      expect(existsSync(h.sidecars.pathFor("ses_gc_fresh"))).toBe(true);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc refuses bare --older-than 0 without --session before any I/O", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_old", "the old session");
      ageAll(h.sidecars, "ses_gc_old", new Date(0));
      for (const raw of ["0", "0d"]) {
        const text = await run(gcCommand, h, `/lossless-gc --older-than ${raw} --apply`);
        expect(text).toBe(
          "LCM gc: --older-than 0 needs --session <id>. Without --session it would match every other sidecar, including ones live in another process.",
        );
      }
      expect(existsSync(h.sidecars.pathFor("ses_gc_old"))).toBe(true);
      expect(readdirSync(h.dir).some((name) => name.startsWith("lossless-export-gc-"))).toBe(false);
      expect(h.records.length).toBe(0);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc --older-than 0 with --session targets only that id", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_a", "the alpha transcript");
      seedDetached(h.sidecars, "ses_gc_b", "the beta transcript");
      ageAll(h.sidecars, "ses_gc_a", new Date(0));
      ageAll(h.sidecars, "ses_gc_b", new Date(0));

      const applied = await run(
        gcCommand,
        h,
        "/lossless-gc --older-than 0 --session ses_gc_a --apply",
      );
      expect(applied).toContain("removed 1 of 1");
      expect(existsSync(h.sidecars.pathFor("ses_gc_a"))).toBe(false);
      expect(existsSync(h.sidecars.pathFor("ses_gc_b"))).toBe(true);
      const exported = applied.split("exported to ")[1]?.split(" ")[0]?.replace(/\.$/u, "");
      expect(exported).toBeDefined();
      expect(readFileSync(exported!, "utf8")).toContain("the alpha transcript");
    } finally {
      h.sidecars.close();
    }
  });

  it("gc --session on a recently active store refuses without --force", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_fresh", "the fresh session");

      const applied = await run(gcCommand, h, "/lossless-gc --session ses_gc_fresh --apply");
      expect(applied).toContain("LCM gc: session ses_gc_fresh was active");
      expect(applied).toContain("minute(s) ago");
      expect(applied).toContain("--force");
      const dry = await run(gcCommand, h, "/lossless-gc --session ses_gc_fresh");
      expect(dry).toContain("LCM gc: session ses_gc_fresh was active");
      expect(existsSync(h.sidecars.pathFor("ses_gc_fresh"))).toBe(true);
      expect(readdirSync(h.dir).some((name) => name.startsWith("lossless-export-gc-"))).toBe(false);
      expect(h.records.some((row) => row.kind === "gc" && row.action === "deleted")).toBe(false);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc --session --force exports then deletes exactly that fresh store", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_fresh", "the fresh force transcript");
      seedDetached(h.sidecars, "ses_gc_other", "the other transcript");
      ageAll(h.sidecars, "ses_gc_other", new Date(0));

      const applied = await run(
        gcCommand,
        h,
        "/lossless-gc --session ses_gc_fresh --force --apply",
      );
      expect(applied).toContain("removed 1 of 1");
      expect(existsSync(h.sidecars.pathFor("ses_gc_fresh"))).toBe(false);
      expect(existsSync(h.sidecars.pathFor("ses_gc_other"))).toBe(true);
      const exported = applied.split("exported to ")[1]?.split(" ")[0]?.replace(/\.$/u, "");
      expect(exported).toBeDefined();
      expect(readFileSync(exported!, "utf8")).toContain("the fresh force transcript");
      expect(
        h.records.some(
          (row) => row.kind === "gc" && row.action === "deleted" && row.session === "ses_gc_fresh",
        ),
      ).toBe(true);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc --force without --session is refused", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_old", "the old session");
      ageAll(h.sidecars, "ses_gc_old", new Date(0));

      const text = await run(gcCommand, h, "/lossless-gc --force --apply");
      expect(text).toBe("LCM gc: --force needs --session <id>.");
      expect(existsSync(h.sidecars.pathFor("ses_gc_old"))).toBe(true);
      expect(h.records.length).toBe(0);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc warns about candidates younger than 24 hours and omits the warning for older ones", async () => {
    const young = harness();
    try {
      seed(young.sidecars, SESSION, "the current session");
      seedDetached(young.sidecars, "ses_gc_young", "the young transcript");
      seedDetached(young.sidecars, "ses_gc_old", "the old transcript");
      ageAll(young.sidecars, "ses_gc_young", new Date(Date.now() - 5 * 3_600_000));
      ageAll(young.sidecars, "ses_gc_old", new Date(0));

      const dry = await run(gcCommand, young, "/lossless-gc --older-than 0.01");
      expect(dry).toContain("younger than 24 hour(s)");
      expect(dry).toContain("ses_gc_young");
    } finally {
      young.sidecars.close();
    }
    const oldOnly = harness();
    try {
      seed(oldOnly.sidecars, SESSION, "the current session");
      seedDetached(oldOnly.sidecars, "ses_gc_old", "the old transcript");
      ageAll(oldOnly.sidecars, "ses_gc_old", new Date(0));

      const dry = await run(gcCommand, oldOnly, "/lossless-gc --older-than 30");
      expect(dry).not.toContain("younger than 24 hour(s)");
    } finally {
      oldOnly.sidecars.close();
    }
  });

  it("gc skips future mtimes in sweeps and lists them as 0.0 days with --force", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_fut", "the future transcript");
      ageAll(h.sidecars, "ses_gc_fut", new Date(Date.now() + 3_600_000));

      const dry = await run(gcCommand, h, "/lossless-gc --older-than 30");
      expect(dry).toContain("nothing eligible");
      expect(dry).toContain("Skipped 1 sidecar(s) active within the last 60 minute(s)");
      expect(dry).toContain("ses_gc_fut");
      expect(existsSync(h.sidecars.pathFor("ses_gc_fut"))).toBe(true);

      const forced = await run(gcCommand, h, "/lossless-gc --session ses_gc_fut --force");
      expect(forced).toContain("ses_gc_fut");
      expect(forced).toContain("0.0 day(s) old");
      expect(existsSync(h.sidecars.pathFor("ses_gc_fut"))).toBe(true);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc grace uses the newest of sqlite, wal, and shm", async () => {
    const h = harness();
    try {
      seed(h.sidecars, SESSION, "the current session");
      seedDetached(h.sidecars, "ses_gc_old", "the old alpha");
      seedDetached(h.sidecars, "ses_gc_wal", "the wal transcript");
      ageAll(h.sidecars, "ses_gc_old", new Date(0));
      ageAll(h.sidecars, "ses_gc_wal", new Date(0));
      writeFileSync(`${h.sidecars.pathFor("ses_gc_wal")}-wal`, "fresh wal bytes");

      const dry = await run(gcCommand, h, "/lossless-gc --older-than 30");
      expect(dry).toContain("ses_gc_old");
      expect(dry).toContain("Skipped 1 sidecar(s) active within the last 60 minute(s)");
      expect(dry).toContain("ses_gc_wal");

      const applied = await run(gcCommand, h, "/lossless-gc --older-than 30 --apply");
      expect(applied).toContain("removed 1 of 1");
      expect(existsSync(h.sidecars.pathFor("ses_gc_wal"))).toBe(true);
      expect(existsSync(h.sidecars.pathFor("ses_gc_old"))).toBe(false);
    } finally {
      h.sidecars.close();
    }
  });

  it("gc docs state the grace, the refusal, and the force rule", async () => {
    const { readFileSync: read } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const doc = read(
      joinPath(
        fileURLToPath(new URL(".", import.meta.url)),
        "../../../apps/docs/content/_snippets/reference/command/opencode.mdx",
      ),
      "utf8",
    );
    expect(doc).toContain(
      "It only excludes sidecars open in this process, so against the shared global directory",
    );
    expect(doc).toContain("60 minutes");
    expect(doc).toContain("--older-than 0");
    expect(doc).toContain("--force");
    expect(doc).toContain("24 hours");
    expect(doc).toContain("Revisit these guards");
  });
});
