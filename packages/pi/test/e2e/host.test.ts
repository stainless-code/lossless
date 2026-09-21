import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ingestEntries, LcmStore } from "lossless-core";
import { beforeAll, test } from "vite-plus/test";

const REPO = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const PACKAGE_DIR = join(REPO, "packages", "pi");

function installed(name: string): string {
  for (let dir = PACKAGE_DIR; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} is not installed`);
  }
}

/** The pinned Pi this package peers on, invoked by path so no global install is
 * needed and a missing one is a failure rather than a silent skip. */
const PI_BIN = join(installed("@earendil-works/pi-coding-agent"), "dist", "bundle", "cli.js");

interface Recorded {
  body: Record<string, unknown>;
  system: string;
}

type Mode = "plain" | "script" | "past";

/** A scripted OpenAI-compatible endpoint. It answers from the request's own
 * content, not from a queue, so an interleaved summarizer call cannot shift the
 * script. The reported `prompt_tokens` is computed from the request body: Pi
 * derives occupancy from the provider's usage, so a canned small number would
 * keep the context below the swap threshold forever. */
function startMock(filePath: string): Promise<{
  bodies: Recorded[];
  port: number;
  setMode: (mode: Mode) => void;
  close: () => Promise<void>;
}> {
  const bodies: Recorded[] = [];
  let mode: Mode = "plain";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
      const messages = Array.isArray(body["messages"])
        ? (body["messages"] as Array<Record<string, unknown>>)
        : [];
      const first = messages[0];
      const system = typeof first?.["content"] === "string" ? (first["content"] as string) : "";
      bodies.push({ body, system });
      const promptTokens = Math.ceil(raw.length / 4);
      sse(res, replyFor(raw, filePath, mode), promptTokens);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        bodies,
        port,
        setMode: (next: Mode) => {
          mode = next;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function replyFor(raw: string, filePath: string, mode: Mode): Reply {
  // The fence tag and the coding-assistant prompt are matched against the whole
  // request: Pi's model registry sends a summarizer call with the prompt as one
  // message and the fenced conversation as another, so the first message alone
  // does not say which kind of call this is.
  if (raw.includes("<conversation_chunk>")) return { text: "leaf summary of the span" };
  if (!raw.includes("expert coding assistant") || mode === "plain") return { text: "noted" };
  if (mode === "past") {
    const tools = (JSON.parse(raw) as { messages: Array<Record<string, unknown>> }).messages
      .filter((m) => m["role"] === "tool")
      .map((m) => (typeof m["content"] === "string" ? m["content"] : ""));
    if (tools.length === 0) {
      return { tool: "lcm_grep", args: { query: "needle", scope: "sessions" } };
    }
    if (tools.length === 1) {
      const pointer = /\[lcm:session ([0-9a-f]{16})[^\]]*\] \[([^\]]+)\]/.exec(tools[0]!);
      if (pointer === null) return { text: "no pointer in the grep answer" };
      return {
        tool: "lcm_expand_query",
        args: {
          session: pointer[1],
          entry_id: pointer[2],
          query: "needle",
          prompt: "What was decided about the needle poller?",
        },
      };
    }
    return { text: "done" };
  }
  const toolNames = (JSON.parse(raw) as { messages: Array<Record<string, unknown>> }).messages
    .filter((m) => m["role"] === "tool")
    .map((m) => (typeof m["name"] === "string" ? m["name"] : ""));
  if (toolNames.length === 0) return { tool: "read", args: { path: filePath } };
  if (toolNames.length === 1) return { tool: "lcm_grep", args: { query: "needle" } };
  if (toolNames.length === 2) return { tool: "read", args: { path: filePath } };
  return { text: "done" };
}

function sse(res: ServerResponse, reply: Reply, promptTokens: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-1",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant", content: "" }, null));
  if ("text" in reply) {
    res.write(chunk({ content: reply.text }, null));
    res.write(chunk({}, "stop"));
  } else {
    res.write(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
            },
          ],
        },
        null,
      ),
    );
    res.write(chunk({}, "tool_calls"));
  }
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-1",
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 7,
        total_tokens: promptTokens + 7,
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

beforeAll(() => {
  const dist = join(REPO, "packages", "core", "dist", "index.mjs");
  if (existsSync(dist)) return;
  const built = spawnSync(process.execPath, [join(REPO, "node_modules", ".bin", "vp"), "pack"], {
    cwd: join(REPO, "packages", "core"),
    encoding: "utf8",
  });
  if (!existsSync(dist)) {
    throw new Error(
      `engine pack failed (${built.status ?? built.error?.message}): ${built.stdout}${built.stderr}`,
    );
  }
}, 120_000);

async function runPi(opts: {
  home: string;
  port: number;
  sessionId: string;
  prompt: string;
  env: Record<string, string>;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args = [
    PI_BIN,
    "--no-extensions",
    "-e",
    join(REPO, "packages", "pi", "src", "index.ts"),
    "-e",
    join(REPO, "packages", "pi", "test", "e2e", "mock-provider.ts"),
    "--provider",
    "mock",
    "--model",
    "mock-1",
    "--session-dir",
    join(opts.home, "sessions"),
    "--session-id",
    opts.sessionId,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--offline",
    "-p",
    opts.prompt,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      // stdin is closed on purpose: an inherited tty leaves Pi waiting for input
      // in print mode instead of finishing the prompt.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: opts.home,
        LCM_E2E_BASE_URL: `http://127.0.0.1:${opts.port}/v1`,
        LCM_E2E_API_KEY: "mock-key",
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) out.push(path);
  }
  return out.sort();
}

test("e2e: a swap reaches the provider wire, and a recall tool reads the store", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-e2e-"));
  const bigFile = join(home, "big.txt");
  writeFileSync(bigFile, `${"needle ".repeat(100)}\n${"filler ".repeat(600)}`, "utf8");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "lcm.json"),
    JSON.stringify({
      swapAtTokens: 800,
      recutAtTokens: 1200,
      keepRecentTokens: 100,
      summaryTokens: 200,
      summarizer: "mock/mock-1",
    }),
    "utf8",
  );
  const mock = await startMock(bigFile);
  const sessionId = "e2e-swap";
  const env: Record<string, string> = {};
  try {
    mock.setMode("plain");
    const first = await runPi({
      home,
      port: mock.port,
      sessionId,
      prompt: "remember the needle",
      env,
    });
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    mock.setMode("script");
    const second = await runPi({ home, port: mock.port, sessionId, prompt: "now read it", env });
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);

    const list = jsonlFiles(join(home, "sessions"));
    assert.equal(list.length, 1, `one session file, got ${JSON.stringify(list)}`);
    const sessionFile = list[0]!;
    const storePath = join(
      home,
      ".pi",
      "agent",
      "lcm",
      `${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}.db`,
    );
    const diagnostics = () =>
      `\n--- requests ---\n${mock.bodies
        .map((b, i) => `${i}: ${JSON.stringify(b.body).slice(0, 300)}`)
        .join("\n")}\n--- store ---\n${storePath}`;

    const store = new DatabaseSync(storePath);
    const messages = store.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number };
    assert.ok(messages.c >= 3, `messages were ingested${diagnostics()}`);
    store.close();

    const lcmDir = join(home, ".pi", "agent", "lcm");
    assert.deepEqual(
      readdirSync(lcmDir)
        .filter((f) => f.endsWith(".db"))
        .sort(),
      [storePath.slice(storePath.lastIndexOf("/") + 1)],
      `stray store files in ${lcmDir}`,
    );

    assert.ok(
      mock.bodies.some((b) => JSON.stringify(b.body).includes("<conversation_chunk>")),
      `a summarizer call reached the provider${diagnostics()}`,
    );
    const db = new DatabaseSync(storePath);
    const leaves = db.prepare("SELECT COUNT(*) c FROM summaries WHERE kind='leaf'").get() as {
      c: number;
    };
    assert.ok(leaves.c >= 1, `a leaf summary exists${diagnostics()}`);
    const leaf = db
      .prepare("SELECT id FROM summaries WHERE kind='leaf' ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    db.close();

    const projected = mock.bodies.find((b) =>
      JSON.stringify(b.body).includes("[LCM session memory"),
    );
    assert.ok(projected, `a request carried the projection${diagnostics()}`);
    const wire = JSON.stringify(projected.body);
    assert.ok(wire.includes(`[lcm:summary #${leaf!.id} depth 0 span`), wire.slice(0, 600));

    const recall = mock.bodies.some((b) => JSON.stringify(b.body).includes("Found 2 match(es)"));
    assert.ok(recall, `lcm_grep returned a hit into the loop${diagnostics()}`);
    const metricsRaw = readFileSync(join(home, ".pi", "agent", "lcm", "metrics.jsonl"), "utf8");
    const recallRows = metricsRaw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["kind"] === "recall");
    assert.ok(
      recallRows.some((r) => r["tool"] === "lcm_grep" && r["outcome"] === "hit"),
      metricsRaw
        .split("\n")
        .filter((l) => l.includes("recall"))
        .join("\n"),
    );

    const sessionText = readFileSync(sessionFile, "utf8");
    assert.equal(
      sessionText.includes("[LCM session memory"),
      false,
      "the session file is untouched",
    );
    assert.ok(statSync(sessionFile).size > 0);
  } finally {
    await mock.close();
  }
}, 120_000);

test("e2e: a fresh session finds a past session's decision through the cross-session scope", async () => {
  const home = mkdtempSync(join(tmpdir(), "lcm-e2e-past-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "lcm.json"),
    JSON.stringify({ summarizer: "mock/mock-1" }),
    "utf8",
  );
  // The past session: a real session file in this project, and a store beside the
  // others holding the decision. Both are what a finished session leaves behind.
  // Under `~/.pi/agent/sessions`, which is the directory the extension reads, even
  // though this harness moves Pi's own session dir elsewhere for isolation.
  const pastFile = join(
    home,
    ".pi",
    "agent",
    "sessions",
    "--repo--",
    "2026-09-01T00-00-00-000Z_past.jsonl",
  );
  mkdirSync(dirname(pastFile), { recursive: true });
  writeFileSync(
    pastFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "past-session",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: REPO,
    })}\n`,
    "utf8",
  );
  const pastHash = createHash("sha256").update(pastFile).digest("hex").slice(0, 16);
  const pastStore = new LcmStore(join(home, ".pi", "agent", "lcm", `${pastHash}.db`));
  ingestEntries(pastStore, [
    {
      entryId: "e00",
      role: "user",
      text: "we decided the needle poller reads the queue twice per tick",
      timestamp: 1,
    },
  ]);
  pastStore.close();
  const pastSidecars = readdirSync(join(home, ".pi", "agent", "lcm"))
    .filter((f) => f.startsWith(pastHash))
    .sort();
  const mock = await startMock(join(home, "unused.txt"));
  try {
    mock.setMode("past");
    const run = await runPi({
      home,
      port: mock.port,
      sessionId: "e2e-past",
      prompt: "what did we decide about the needle poller last week?",
      env: {},
    });
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const wire = mock.bodies.map((b) => JSON.stringify(b.body)).join("\n");
    assert.ok(
      wire.includes(`[lcm:session ${pastHash} `),
      `the cross-session pointer reached the loop${wire.slice(0, 400)}`,
    );
    assert.ok(wire.includes("we decided the needle poller"), "the past decision was found");

    assert.ok(
      wire.includes(`<recovered_findings session=\\"${pastHash}\\"`) ||
        wire.includes(`<recovered_findings session="${pastHash}"`),
      `the findings were labelled as a past session's${wire.slice(-4000)}`,
    );

    for (const [index, recorded] of mock.bodies.entries()) {
      const messages = (recorded.body["messages"] ?? []) as Array<Record<string, unknown>>;
      for (const m of messages) {
        if (m["role"] === "tool") continue;
        const text = JSON.stringify(m["content"]);
        assert.equal(
          text.includes("reads the queue twice per tick"),
          false,
          `request ${index} carried foreign text in a ${String(m["role"])} message`,
        );
        // The tool *description* teaches the pointer shape, so the system
        // prompt naming "[lcm:session" is fine. The hash itself is not: it
        // appears only inside the tool call and its result.
        assert.equal(
          text.includes(pastHash),
          false,
          `request ${index} leaked the past session into ${String(m["role"])}`,
        );
      }
    }
    const pastAfter = new DatabaseSync(join(home, ".pi", "agent", "lcm", `${pastHash}.db`));
    const rows = pastAfter.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number };
    pastAfter.close();
    assert.equal(rows.c, 1, "the past store still holds exactly its own one message");
    assert.deepEqual(
      readdirSync(join(home, ".pi", "agent", "lcm"))
        .filter((f) => f.startsWith(pastHash))
        .sort(),
      pastSidecars,
      "the past session's store files were not rewritten",
    );

    const recallRows = readFileSync(join(home, ".pi", "agent", "lcm", "metrics.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["kind"] === "recall" && r["tool"] === "lcm_grep");
    assert.ok(
      recallRows.some((r) => r["outcome"] === "hit" && typeof r["sessionsScanned"] === "number"),
      JSON.stringify(recallRows),
    );
  } finally {
    await mock.close();
  }
}, 120_000);
