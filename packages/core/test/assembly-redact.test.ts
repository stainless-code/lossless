import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { cutIndexFor, buildSynthetic, renderFrontier } from "../src/assembly.ts";
import { renderSummaries, STUB_CHARS } from "../src/assembly.ts";
import { estimateTokens } from "../src/estimate-tokens.ts";
import { ingestEntries, isIngestible } from "../src/ingest.ts";
import { expandView } from "../src/recall-view.ts";
import { redactSecrets } from "../src/redact.ts";
import { LcmStore } from "../src/store.ts";

function msg(role: string, text: string): { role: string; content: unknown } {
  return { role, content: [{ type: "text", text: text.repeat(50) }] };
}

test("assembly: the frontier renders each node's own text, header first", () => {
  const nodes = [
    { id: 3, depth: 1, firstEntryId: "e1", lastEntryId: "e4", text: "first" },
    { id: 4, depth: 1, firstEntryId: "e5", lastEntryId: "e9", text: "second" },
  ];
  assert.equal(
    renderFrontier(nodes),
    "[lcm:summary #3 depth 1 span e1..e4]\nfirst\n\n[lcm:summary #4 depth 1 span e5..e9]\nsecond",
  );
});

test("assembly: cut lands on a user message (never splits tool pairs)", () => {
  const messages = [
    msg("user", "u1 "),
    msg("assistant", "a1 "),
    msg("toolResult", "t1 "),
    msg("user", "u2 "),
    msg("assistant", "a2 "),
    msg("toolResult", "t2 "),
    msg("user", "u3 "),
  ];
  assert.equal(cutIndexFor(messages, 10), 6);
  assert.equal(cutIndexFor(messages, 150), 3);
  assert.equal(cutIndexFor(messages, 100), 3);
});

test("assembly: a long tool-call run still finds the user boundary", () => {
  const messages = [
    msg("user", "u1 "),
    ...Array.from({ length: 5 }, () => msg("assistant", "a ")),
    msg("user", "u2 "),
    ...Array.from({ length: 260 }, () => msg("assistant", "a ")),
    msg("user", "u3 "),
  ];
  assert.equal(cutIndexFor(messages, 400), 6);
});

test("assembly: bails (-1) when no user boundary exists", () => {
  const messages = [msg("assistant", "a"), msg("toolResult", "t")];
  assert.equal(cutIndexFor(messages, 1), null);
});

test("assembly: a head with no user boundary cuts at the session's next user turn", () => {
  const messages = [msg("compactionSummary", "c0 "), msg("assistant", "a1 "), msg("user", "u2 ")];
  assert.equal(cutIndexFor(messages, 60), 2);
  assert.equal(cutIndexFor([msg("compactionSummary", "c0 "), msg("assistant", "a1 ")], 60), null);
});

test("assembly: one user turn over the floor cuts at a tool-safe boundary", () => {
  const messages = [
    msg("user", "u1 "),
    ...Array.from({ length: 40 }, (_, i) => msg(i % 2 === 0 ? "assistant" : "toolResult", "a ")),
  ];
  const cut = cutIndexFor(messages, 150);
  assert.ok(cut !== null && cut > 0, `expected a cut above the session start, got ${cut}`);
  assert.equal(messages[cut]!.role, "assistant");
  assert.equal(messages[cut - 1]!.role, "toolResult");
});

test("assembly: tiny keepRecent still keeps a user boundary", () => {
  const messages = Array.from({ length: 30 }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `m${i} `),
  );
  assert.equal(cutIndexFor(messages, 10), 28);
});

test("assembly: synthetic block carries the marker and recall pointers", () => {
  // The engine writes the pointer line; the model never has to reproduce an id.
  const synth = buildSynthetic([
    { id: 1, depth: 0, firstEntryId: "e0", lastEntryId: "e4", text: "summary text", tier: "terse" },
    {
      id: 2,
      depth: 1,
      firstEntryId: "e5",
      lastEntryId: "e9",
      text: "second summary",
      tier: "terse",
    },
  ]);
  assert.equal(synth.role, "user");
  assert.equal(
    synth.content,
    "[LCM session memory: earlier conversation is compacted into the summaries below. " +
      "Originals are recoverable verbatim: lcm_expand_query(query, prompt) reads them from the store, lcm_grep(query) finds them.\n\n" +
      "[lcm:summary #1 depth 0 span e0..e4]\nsummary text\n\n" +
      "[lcm:summary #2 depth 1 span e5..e9]\nsecond summary",
  );
});

test("assembly: a stubbed node keeps its pointer and loses only text", () => {
  const long = "word ".repeat(200).trim();
  const [block] = [
    renderSummaries([
      { id: 7, depth: 3, firstEntryId: "e0", lastEntryId: "e4", text: long, tier: "stub" },
    ]),
  ];
  assert.ok(block.startsWith("[lcm:summary #7 depth 3 span e0..e4]\n"));
  const body = block.split("\n")[1]!;
  assert.ok(!body.includes("\n"));
  assert.ok(body.includes(long.slice(0, STUB_CHARS)), "keeps a slice of the text");
  assert.ok(!body.includes(long.slice(0, STUB_CHARS + 20)), "stops at STUB_CHARS");
  assert.ok(body.includes(`lcm_describe(7)`), "points at the full summary");
  assert.ok(body.includes(`${long.length} chars`), "reports how much was elided");
  assert.ok(estimateTokens(block) < estimateTokens(long) / 3, "a stub is far cheaper");

  assert.equal(
    renderSummaries([
      { id: 7, depth: 3, firstEntryId: "e0", lastEntryId: "e4", text: "short", tier: "terse" },
    ]),
    "[lcm:summary #7 depth 3 span e0..e4]\nshort",
  );

  assert.ok(
    !buildSynthetic([
      { id: 1, depth: 0, firstEntryId: "e0", lastEntryId: "e4", text: "t", tier: "terse" },
    ]).content.includes("stubbed"),
  );
  const stubbed = buildSynthetic([
    { id: 1, depth: 0, firstEntryId: "e0", lastEntryId: "e4", text: "t", tier: "stub" },
    { id: 2, depth: 0, firstEntryId: "e5", lastEntryId: "e9", text: "t", tier: "terse" },
  ]);
  assert.ok(stubbed.content.includes("1 of 2 summaries are stubbed"));
  assert.ok(stubbed.content.includes("#1") && stubbed.content.includes("#2"), "both pointers stay");
});

test("redaction: OpenAI-style keys", () => {
  assert.equal(
    redactSecrets("my key is sk-abcdefghijklmnop1234567890 ok"),
    "my key is [REDACTED] ok",
  );
});

test("redaction: GitHub tokens, AWS keys, bearer headers", () => {
  const t = "ghp_1234567890abcdefghij and AKIAIOSFODNN7EXAMPLE and Bearer abc.def.ghi-jkl_mno";
  assert.equal(redactSecrets(t), "[REDACTED] and [REDACTED] and [REDACTED]");
});

test("redaction: generic KEY=/TOKEN= assignments keep the key name and quoting", () => {
  assert.equal(
    redactSecrets('OPENROUTER_API_KEY: "sk-or-v1-abcdef1234567890abcdef"'),
    'OPENROUTER_API_KEY: "[REDACTED]"',
  );
  assert.equal(redactSecrets("export DB_PASSWORD=hunter2hunter2"), "export DB_PASSWORD=[REDACTED]");
  assert.equal(redactSecrets('{"apiToken": "abcdefgh12345678"}'), '{"apiToken": "[REDACTED]"}');
});

test("redaction: leaves normal code alone", () => {
  const code = "const port = process.env.PORT ?? 3000;\nrun(server, { port });";
  assert.equal(redactSecrets(code), code);
});

test("redaction: counter removed: generic pattern covers the same shape", () => {
  assert.equal(redactSecrets("token = abcdefgh12345678"), "token = [REDACTED]");
});

test("redaction: leaves source code alone", () => {
  const code = [
    "tokens: Number(r.tokens),",
    "keepRecentTokens: input.keepRecentTokens,",
    "summaryTokens: config.summaryTokens ?? 1500,",
    "tailKey: tailKeyOf(rawMessages[cut]),",
    "tokens: number;",
    "const SECRET_PATTERNS: RegExp[] = [];",
    "const targetTokens = input.targetTokens ?? 1500;",
    "const sourceTokens = items.reduce((n, m) => n + m.text.length, 0);",
    "const tokens = estimateTokens(text);",
    "result.pinnedModelKey = input.pinnedModelKey!;",
    "const customData = { secretKey: getSecretKey(id), tokenCount: cfg.maxTokens ?? 0 };",
  ].join("\n");
  assert.equal(redactSecrets(code), code);
});

test("redaction: a bare value that reads as a key is still redacted", () => {
  assert.equal(redactSecrets("api_key: abcdefgh12345678"), "api_key: [REDACTED]");
  assert.equal(redactSecrets("api_key=abc-def_123456"), "api_key=[REDACTED]");
});

test("redaction: a bare identifier value is not a secret", () => {
  assert.equal(redactSecrets("api_key: readFromVault"), "api_key: readFromVault");
  assert.equal(
    redactSecrets("credential = readCredentialFromEnv"),
    "credential = readCredentialFromEnv",
  );
});

test("redaction: a quoted config string on a key-named field is not a secret", () => {
  assert.equal(redactSecrets('modelKey: "test/model"'), 'modelKey: "test/model"');
  assert.equal(
    redactSecrets('pinnedModelKey: "input.pinnedModelKey"'),
    'pinnedModelKey: "input.pinnedModelKey"',
  );
  assert.equal(redactSecrets('apiKey: "abcdefgh12345678"'), 'apiKey: "[REDACTED]"');
});

test("redaction: the env shape carries the decision for a letter-only value", () => {
  assert.equal(redactSecrets("API_KEY=aaaabbbbccccddddeeeeffff"), "API_KEY=[REDACTED]");
  assert.equal(
    redactSecrets("secretKey: aaaabbbbccccddddeeeeffff"),
    "secretKey: aaaabbbbccccddddeeeeffff",
  );
});

test("ingest: the store holds the key, and the first read masks it", () => {
  const s = new LcmStore(":memory:");
  const key = "sk-abcdefghij0123456789";
  const text = `cat .env → SECRET_KEY=${key} in the shell`;
  ingestEntries(s, [
    {
      entryId: "e1",
      role: "toolResult",
      text,
      timestamp: 1,
    },
  ]);
  assert.deepEqual(
    s.grep(JSON.stringify(key)).map((h) => h.text),
    [text],
    "the row is verbatim, so the key it holds is still findable",
  );
  const read = expandView(s, redactSecrets, {
    mode: "message",
    entryId: "e1",
    charOffset: 0,
    maxChars: 4000,
  });
  assert.ok(read.ok);
  assert.equal(read.text.includes(key), false, read.text);
  assert.ok(read.text.includes("SECRET_KEY=[REDACTED]"), read.text);
  s.close();
});

test("redaction: npm tokens, GCP OAuth, PEM keys, bare JWTs", () => {
  const t = [
    "npm_abcdefghijklmnopqrst",
    "ya29.fake-fake-fake-fake-fake",
    "1//0fakefakefakefakefakefake",
    "eyJfakeAAAA.eyJfakeBBBB.eyJfakeCCCCCC",
    "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----",
  ].join("\n");
  assert.equal(redactSecrets(t), "[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]");
});

test("redaction: masking never flips ingestibility (blank in, blank out; text in, text out)", () => {
  const corpus = [
    "",
    "   ",
    "\n\t  \n",
    "hello world",
    "  padded prose  ",
    "héllo wörld ✓ — unicode survives",
    "const port = process.env.PORT ?? 3000;",
    "my key is sk-abcdefghijklmnop1234567890 ok",
    "sk-abcdefghijklmnop1234567890",
    "  ghp_1234567890abcdefghij  ",
    "ghp_1234567890abcdefghij and AKIAIOSFODNN7EXAMPLE and Bearer abc.def.ghi-jkl_mno",
    "export DB_PASSWORD=hunter2hunter2",
    "token = abcdefgh12345678",
    '{"apiToken": "abcdefgh12345678"}',
    "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----",
    "eyJfakeAAAA.eyJfakeBBBB.eyJfakeCCCCCC",
    "line one\npassword=hunter2value\nline three",
    "password=aaa111\npassword=bbb222",
    "prose then sk-abcdefghijklmnop1234567890",
  ];
  for (const text of corpus) {
    const masked = redactSecrets(text);
    assert.equal(
      masked.trim().length > 0,
      text.trim().length > 0,
      `masking flipped blankness: ${JSON.stringify(text)} -> ${JSON.stringify(masked)}`,
    );
    assert.equal(
      isIngestible({ entryId: "e", text: masked }),
      isIngestible({ entryId: "e", text }),
      `masking flipped ingestibility: ${JSON.stringify(text)}`,
    );
  }
});
