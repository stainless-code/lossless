import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDiagnoseBundle,
  hostVersion,
  packageVersionNear,
  readSessionFormat,
  sessionFactLines,
  MAX_BUNDLE_BYTES,
  MAX_METRIC_ROWS,
  type DiagnoseBundleInput,
  type SessionFacts,
} from "lossless-core";
import { redactSecrets } from "lossless-core";
import { test } from "vite-plus/test";

import { piHostLabel, pluginLabel, pluginVersion } from "../src/host.ts";

const HOST_PACKAGE = "@earendil-works/pi-coding-agent";

/** A home that looks like a real one, so a leak of it is visible in the text. */
const HOME = "/Users/reporter";

function facts(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    stats: {
      messages: 12,
      summaries: 3,
      dbBytes: 120_000,
      payloadMessages: 0,
      payloadBytes: 0,
      files: 0,
      fileBytes: 0,
      removedMessages: 0,
    },
    integrity: { checks: 7, findings: [], repairs: [] },
    depthRows: [{ depth: 0, count: 3, totalTokens: 900, avgTokens: 300 }],
    pin: null,
    model: "openai-codex/gpt-5-codex",
    window: { tokens: 200_000, effective: { swap: 0.7, recut: 0.85, clamped: false } },
    chain: { level: "info", state: "summarizer: a/one → s/session · config: a/one" },
    zoneConfigured: false,
    config: { assemblyEnabled: true },
    keepRecentTokens: 20_000,
    configPath: `${HOME}/.pi/agent/lcm.json`,
    ...over,
  };
}

function bundle(over: Partial<DiagnoseBundleInput> = {}): string {
  return buildDiagnoseBundle({
    versions: { plugin: () => "pi-lossless 0.13.0", host: () => "pi 0.5.0" },
    runtime: { node: "v25.9.0", platform: "darwin", arch: "arm64", mode: "tui" },
    session: { store: "ea565db130478d48.db", file: "2026-09-15T10-00-00-000Z.jsonl", format: "v3" },
    facts: facts(),
    config: { effective: '{"assemblyEnabled":true}', path: `${HOME}/.pi/agent/lcm.json` },
    metrics: [],
    redact: redactSecrets,
    home: HOME,
    ...over,
  });
}

test("diagnose: the bundle carries every section, and no stored text has a field to travel in", () => {
  const text = bundle({
    metrics: [
      {
        event: "lcm",
        kind: "summarizer-error",
        session: "ea565db130478d48",
        reason: "threw",
        error: `provider said no: sk-${"A".repeat(20)}`,
      },
    ],
  });
  for (const section of [
    "LCM diagnose bundle: pi-lossless 0.13.0, pi 0.5.0, node v25.9.0, darwin/arm64, mode tui",
    "session: store ea565db130478d48.db, file 2026-09-15T10-00-00-000Z.jsonl, format v3",
    "store:",
    "  messages: 12, summaries: 3, size: 117 KB",
    "config (~/.pi/agent/lcm.json):",
    '  {"assemblyEnabled":true}',
    "metrics: 1 row(s) for this session, 1 shown, 0 not shown",
  ]) {
    assert.ok(text.includes(section), `missing section: ${section}\n${text}`);
  }
  assert.ok(text.startsWith("LCM diagnose bundle: pi-lossless"), text);
  assert.match(text, /^omitted: no message body, no summary text, no search query/m);
  assert.ok(!text.includes(`sk-${"A".repeat(20)}`), text);
  assert.ok(text.includes("provider said no: [REDACTED]"), text);
});

test("diagnose: the header names the host's own products, so the engine names none", () => {
  const text = bundle({
    versions: { plugin: () => "opencode-lossless 1.2.3", host: () => "opencode 0.9.0" },
  });
  assert.ok(
    text.startsWith("LCM diagnose bundle: opencode-lossless 1.2.3, opencode 0.9.0, node"),
    text,
  );
  assert.ok(!text.includes("pi-lossless"), text);
});

test("diagnose: the mask runs on foreign strings and leaves the model keys alone", () => {
  const key = `sk-${"A".repeat(20)}`;
  const text = bundle({
    metrics: [
      {
        event: "lcm",
        kind: "context-decision",
        ts: 1_700_000_000_000,
        session: "ea565db130478d48",
        action: "swap",
        reason: "over-soft-threshold",
        modelKey: "openai-codex/gpt-5-codex",
        pinnedModelKey: "anthropic/claude-sonnet-4-5-20250929",
        tokens: 123_456_789,
      },
      {
        event: "lcm",
        kind: "summarizer-error",
        session: "ea565db130478d48",
        reason: "threw",
        error: `the provider rejected the key ${key}`,
      },
    ],
  });
  assert.ok(!text.includes(key.slice(-20)), "the foreign error text is masked whole\n" + text);
  assert.ok(text.includes("[REDACTED]"), text);
  assert.ok(text.includes("openai-codex/gpt-5-codex"), text);
  assert.ok(text.includes("anthropic/claude-sonnet-4-5-20250929"), text);
  assert.ok(text.includes("123456789"), text);
  assert.ok(text.includes("over-soft-threshold"), text);
});

test("diagnose: a row with no kind is tallied by its event", () => {
  const text = bundle({
    metrics: [
      {
        ts: 1,
        event: "usage",
        session: "ea565db130478d48",
        input: 26,
        output: 13,
        costTotal: 0.0005,
      },
    ],
  });
  assert.match(text, /^ {2}by kind \(shown\): usage 1$/m, text);
});

test("diagnose: a nested attempt error is masked too", () => {
  const text = bundle({
    metrics: [
      {
        event: "lcm",
        kind: "summarizer-fallback",
        session: "ea565db130478d48",
        attempts: [
          {
            model: "openai-codex/gpt-5-codex",
            outcome: "threw",
            error: `config secret: sk-${"A".repeat(20)}`,
          },
          { model: "anthropic/claude-sonnet-4-5", outcome: "ok" },
        ],
        used: "anthropic/claude-sonnet-4-5",
      },
    ],
  });
  assert.ok(!text.includes(`sk-${"A".repeat(20)}`), text);
  assert.ok(text.includes("config secret: [REDACTED]"), text);
  assert.ok(text.includes("anthropic/claude-sonnet-4-5"), text);
});

test("diagnose: an absolute path outside the home never prints", () => {
  const text = bundle({
    metrics: [
      {
        event: "lcm",
        kind: "file-externalized",
        session: "ea565db130478d48",
        entryId: "1a2b3c4d",
        fileId: "5e6f7a8b",
        path: "/Users/someone-else/private/notes.md",
        fileKind: "text",
        bytes: 4096,
      },
      {
        event: "lcm",
        kind: "gc-deleted",
        db: "ea565db130478d48.db",
        reason: "session file gone",
        sizeBytes: 4096,
        exportedTo: `${HOME}/.pi/agent/lcm/export.jsonl`,
      },
    ],
  });
  assert.ok(!text.includes("/Users/"), text);
  assert.ok(!text.includes("someone-else"), text);
  assert.ok(text.includes('"path":"<path>"'), text);
  assert.ok(text.includes("~/.pi/agent/lcm/export.jsonl"), text);
});

test("diagnose: 5,000 rows stay under the ceiling and name what they hid", () => {
  const rows = Array.from({ length: 5_000 }, (_, i) => ({
    event: "lcm",
    kind: "summarizer-usage",
    ts: 1_700_000_000_000 + i,
    session: "ea565db130478d48",
    model: "openai-codex/gpt-5-codex",
    input: 12_345 + i,
    output: 678 + i,
    costTotal: 0.001,
  }));
  const text = bundle({ metrics: rows });
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_BUNDLE_BYTES, String(text.length));
  assert.ok(text.includes("metrics: 5000 row(s) for this session,"), text);
  assert.ok(text.includes(", 5000 not shown") === false, text);
  const shown = /metrics: 5000 row\(s\) for this session, (\d+) shown, (\d+) not shown/.exec(text);
  assert.ok(shown, text);
  assert.equal(Number(shown[1]) + Number(shown[2]), 5_000);
  assert.ok(Number(shown[2]) > 0, "a row this small still cannot all fit");
  assert.ok(text.includes(`"input":${12_345 + 4_999}`), "the newest row is printed");
});

test("diagnose: the last decision row is printed even when it is older than the tail", () => {
  const rows = [
    { event: "lcm", kind: "context-decision", session: "ea565db130478d48", action: "recut" },
    ...Array.from({ length: MAX_METRIC_ROWS + 5 }, (_, i) => ({
      event: "lcm",
      kind: "recall",
      session: "ea565db130478d48",
      tool: "lcm_grep",
      outcome: "miss",
      hits: i,
    })),
  ];
  const text = bundle({ metrics: rows });
  assert.match(
    text,
    /^ {2}last decision: \{"event":"lcm","kind":"context-decision".*"action":"recut"\}$/m,
  );
  assert.equal(text.split('"kind":"context-decision"').length - 1, 1, text);
});

test("diagnose: the facts section is the one doctor prints", () => {
  const lines = sessionFactLines(
    facts({
      configPath: undefined,
      integrity: {
        checks: 7,
        repairs: ["rebuilt the full-text index"],
        findings: [
          { kind: "summary-span", severity: "violation", count: 1, detail: "x", sample: ["#1"] },
        ],
      },
    }),
  );
  assert.equal(lines[0], "messages: 12, summaries: 3, size: 117 KB");
  assert.ok(lines.includes("repair: rebuilt the full-text index"), lines.join("\n"));
  assert.ok(lines.includes("integrity: 7 checks, 1 finding(s)"), lines.join("\n"));
  assert.ok(lines.includes("  depth 0 (leaf): 3 summaries, 900 tokens total, 300 avg"));
  assert.ok(lines.includes("pinned projection: none"));
  assert.ok(!lines.some((l) => l.startsWith("config: ")), lines.join("\n"));
});

test("diagnose: the session format version comes from the file's header line", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcm-diagnose-"));
  const good = join(dir, "sess.jsonl");
  writeFileSync(
    good,
    `${JSON.stringify({ type: "session", version: 3, cwd: HOME })}\n{"type":"message"}\n`,
  );
  assert.equal(readSessionFormat(good), "v3");
  const garbage = join(dir, "garbage.jsonl");
  writeFileSync(garbage, "not json\n");
  assert.equal(readSessionFormat(garbage), "unknown (first line is not a session header)");
  const other = join(dir, "other.jsonl");
  writeFileSync(other, `${JSON.stringify({ type: "message", version: 3 })}\n`);
  assert.equal(readSessionFormat(other), "unknown (first line is not a session header)");
  assert.equal(readSessionFormat(join(dir, "absent.jsonl")), "unknown (unreadable)");
  assert.equal(readSessionFormat(undefined), "unknown (no session file)");
});

test("diagnose: the bundle never names the home directory", () => {
  const text = bundle({
    config: {
      effective: `{"db":"${HOME}/.pi/agent/lcm/x.db"}`,
      path: `${HOME}/.pi/agent/lcm.json`,
    },
  });
  assert.ok(!text.includes(HOME), text);
  assert.ok(!text.includes("/Users/"), text);
  assert.ok(text.includes("~/.pi/agent/lcm/x.db"), text);
});

test("diagnose: the plugin version is this package's version, from src or dist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(pkg.name, "pi-lossless");
  assert.equal(pluginVersion(), pkg.version);
  assert.equal(pluginLabel(), `pi-lossless ${pkg.version}`);
});

test("diagnose: the host version is Pi's, and a wrong anchor says so", () => {
  assert.match(
    hostVersion(HOST_PACKAGE, import.meta.url),
    /^\d+\.\d+\.\d+/,
    hostVersion(HOST_PACKAGE, import.meta.url),
  );
  assert.equal(piHostLabel(), `pi ${hostVersion(HOST_PACKAGE, import.meta.url)}`);
  const dir = mkdtempSync(join(tmpdir(), "lcm-diagnose-version-"));
  assert.equal(packageVersionNear(join(dir, "nested", "file.js"), "pi-lossless"), undefined);
});
