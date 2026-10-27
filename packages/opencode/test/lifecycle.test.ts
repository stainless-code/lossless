import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
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
      expect(first).toBe(`sidecar: ${h.dir} (explicit)`);
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

  it("lists and deletes an old sidecar, exporting it first", async () => {
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
});
