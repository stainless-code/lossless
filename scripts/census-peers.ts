import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE = "node_modules/.cache/peer-census";
const PACKAGE_KEYWORD = "keywords:pi-package";
const PAGE = 250;
const TERMS = ["memory", "compact", "context", "summary", "recall"] as const;
const SELF_DESCRIBED = /compact|summari/i;

interface SearchPackage {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date?: string;
  links?: Record<string, string>;
}

interface SearchResponse {
  total: number;
  objects: { package: SearchPackage }[];
}

interface Candidate {
  name: string;
  version: string;
  date: string;
  description: string;
}

interface Signals {
  replacement: boolean;
  contextHook: boolean;
  modelCall: boolean;
  sqlite: boolean;
  fts: boolean;
  vector: boolean;
  markdown: boolean;
  piManifest: boolean;
  evidence: string[];
}

const PROBES: [keyof Omit<Signals, "evidence" | "piManifest">, RegExp][] = [
  ["replacement", /firstKeptEntryId/],
  ["contextHook", /(?:on|register\w*|hooks?\s*[:=])[^\n]{0,60}["'`]context["'`]/i],
  [
    "modelCall",
    /streamSimple|streamText|generateText|chat\/completions|ctx\.llm|\.createMessage\(/,
  ],
  ["sqlite", /node:sqlite|bun:sqlite|better-sqlite3/],
  ["fts", /fts5|USING fts\b|bm25\(|\bMATCH\s*[?('"]/],
  ["vector", /sqlite-vec|vec0|cosineSimilarity|Float32Array/],
  ["markdown", /\.md["'`)]/],
];

async function fetchJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.ok) return (await response.json()) as T;
    const retriable = response.status === 429 || response.status >= 500;
    if (!retriable || attempt >= 5) throw new Error(`${response.status} ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
}

async function everyPiPackage(): Promise<Candidate[]> {
  const cached = join(CACHE, "pi-packages.json");
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8")) as Candidate[];
  const rows: Candidate[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchJson<SearchResponse>(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(PACKAGE_KEYWORD)}&size=${PAGE}&from=${from}`,
    );
    for (const entry of page.objects) {
      const pkg = entry.package;
      rows.push({
        name: pkg.name,
        version: pkg.version,
        date: (pkg.date ?? "").slice(0, 10),
        description: pkg.description ?? "",
      });
    }
    from += PAGE;
    if (from >= page.total || page.objects.length === 0) break;
    if (from >= 20_000) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify(rows, null, 2));
  return rows;
}

function matches(candidate: Candidate, term: string): boolean {
  const haystack = `${candidate.name} ${candidate.description}`.toLowerCase();
  return haystack.includes(term);
}

function tarballUrl(name: string, version: string): Promise<string> {
  return fetchJson<{ versions: Record<string, { dist: { tarball: string } }> }>(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  ).then((doc) => {
    const entry = doc.versions[version];
    if (!entry) throw new Error(`no ${version} for ${name}`);
    return entry.dist.tarball;
  });
}

async function unpack(candidate: Candidate): Promise<string> {
  const dir = join(CACHE, "trees", `${candidate.name.replace(/[/@]/g, "_")}-${candidate.version}`);
  if (existsSync(join(dir, "package"))) return join(dir, "package");
  const url = await tarballUrl(candidate.name, candidate.version);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, "package.tgz");
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  return join(dir, "package");
}

function shippedFiles(root: string, depth = 0): string[] {
  if (depth > 6) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(root, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (/^(tests?|__tests__|__mocks__|bench(mark)?s?|fixtures?)$/.test(entry)) continue;
      out.push(...shippedFiles(path, depth + 1));
      continue;
    }
    if (!/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry)) continue;
    if (/\.(test|spec)\./.test(entry)) continue;
    out.push(path);
  }
  return out;
}

function classify(root: string): Signals {
  const signals: Signals = {
    replacement: false,
    contextHook: false,
    modelCall: false,
    sqlite: false,
    fts: false,
    vector: false,
    markdown: false,
    piManifest: false,
    evidence: [],
  };
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      pi?: unknown;
    };
    signals.piManifest = manifest.pi !== undefined;
  } catch {
    signals.piManifest = false;
  }
  for (const file of shippedFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const [key, probe] of PROBES) {
      if (signals[key]) continue;
      const hit = probe.exec(text);
      if (!hit) continue;
      signals[key] = true;
      const line = text.slice(0, hit.index).split("\n").length;
      signals.evidence.push(`${key}:${file.slice(root.length + 1)}:${line}`);
    }
    if (PROBES.every(([key]) => signals[key])) break;
  }
  return signals;
}

async function pool(): Promise<void> {
  const all = await everyPiPackage();
  const counts = new Map<string, Candidate[]>(TERMS.map((term) => [term, []]));
  const union = new Map<string, Candidate>();
  for (const candidate of all) {
    for (const term of TERMS) {
      if (!matches(candidate, term)) continue;
      counts.get(term)?.push(candidate);
      union.set(candidate.name, candidate);
    }
  }
  console.log(`pi-package packages: ${all.length}`);
  for (const term of TERMS) {
    console.log(`  ${term}: ${counts.get(term)?.length ?? 0}`);
  }
  const selfDescribed = [...union.values()].filter((c) => SELF_DESCRIBED.test(c.description));
  console.log(`candidate pool (union): ${union.size}`);
  console.log(`self-described as compaction or summarization: ${selfDescribed.length}`);
  console.log(`written to ${join(CACHE, "candidates.json")}`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(
    join(CACHE, "candidates.json"),
    JSON.stringify(
      [...union.values()].sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2,
    ),
  );
}

async function census(): Promise<void> {
  const file = join(CACHE, "candidates.json");
  if (!existsSync(file)) throw new Error("run `census-peers.ts pool` first");
  const candidates = JSON.parse(readFileSync(file, "utf8")) as Candidate[];
  const report: { name: string; version: string; signals: Signals }[] = [];
  for (const candidate of candidates) {
    try {
      const root = await unpack(candidate);
      report.push({ name: candidate.name, version: candidate.version, signals: classify(root) });
    } catch (error) {
      console.error(`skip ${candidate.name}: ${(error as Error).message}`);
    }
  }
  const withSignals = report.map((row) => row.signals);
  const tally = (pick: (signals: Signals) => boolean): number => withSignals.filter(pick).length;
  const replacements = report.filter((row) => row.signals.replacement);
  const stores = replacements.filter(
    (row) => row.signals.sqlite || row.signals.fts || row.signals.vector || row.signals.markdown,
  );
  console.log(`classified: ${report.length}`);
  console.log(`returns a replacement compaction: ${replacements.length}`);
  console.log(`  of those, keeps a store: ${stores.length}`);
  console.log(`  SQLite: ${tally((s) => s.replacement && s.sqlite)}`);
  console.log(`  full-text index: ${tally((s) => s.replacement && s.fts)}`);
  console.log(`  vector index: ${tally((s) => s.replacement && s.vector)}`);
  console.log(`compacts with no model call: ${tally((s) => s.replacement && !s.modelCall)}`);
  console.log(`registers a context hook: ${tally((s) => s.contextHook)}`);
  console.log(`declares no \`pi\` manifest key: ${tally((s) => !s.piManifest)}`);
  const out = join(CACHE, "census.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`written to ${out}`);
}

async function metadata(names: string[]): Promise<void> {
  for (const name of names) {
    try {
      const doc = await fetchJson<{
        "dist-tags": { latest: string };
        time: Record<string, string>;
      }>(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      const version = doc["dist-tags"].latest;
      const date = (doc.time[version] ?? "").slice(0, 10);
      const prereleases = Object.keys(doc.time)
        .filter(
          (key) => key !== "created" && key !== "modified" && key !== version && /-/.test(key),
        )
        .map((key) => ({ key, at: (doc.time[key] ?? "").slice(0, 10) }))
        .sort((a, b) => a.at.localeCompare(b.at));
      const newest = prereleases[prereleases.length - 1];
      const extra = newest ? `  prerelease ${newest.key} ${newest.at}` : "";
      console.log(`${name}\t${version}\t${date}${extra}`);
    } catch (error) {
      console.log(`${name}\tunpublished\t${(error as Error).message}`);
    }
  }
}

const HOOK_TOKENS = [
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "message_end",
  "turn_end",
  "tool_result",
  "tool_call",
  "context",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "model_select",
  "agent_end",
  "agent_settled",
  "input",
];

async function measure(spec: string): Promise<void> {
  const at = spec.startsWith("@") ? spec.lastIndexOf("@") : spec.indexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const pinned = at > 0 ? spec.slice(at + 1) : "";
  const version =
    pinned ||
    (
      await fetchJson<{ "dist-tags": { latest: string } }>(
        `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      )
    )["dist-tags"].latest;
  const root = await unpack({ name, version, date: "", description: "" });
  const files = shippedFiles(root);
  const texts = files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
  const loc = texts.reduce((sum, entry) => sum + entry.text.split("\n").length, 0);
  const hooks = HOOK_TOKENS.filter((hook) =>
    texts.some((entry) => entry.text.includes(`"${hook}"`) || entry.text.includes(`'${hook}'`)),
  );
  const toolPattern =
    /register\w*Tool\w*\(\s*\{[\s\S]{0,160}?name:\s*["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?)["'`]/g;
  const tools = new Set<string>();
  for (const entry of texts) {
    for (const match of entry.text.matchAll(toolPattern)) if (match[1]) tools.add(match[1]);
  }
  const signals = classify(root);
  console.log(`${name} ${version}`);
  console.log(`  shipped code: ${files.length} files, ${loc} lines`);
  console.log(`  hooks named: ${hooks.join(", ") || "none"}`);
  console.log(`  tools: ${[...tools].sort().join(", ") || "none"}`);
  console.log(
    `  signals: replacement=${signals.replacement} contextHook=${signals.contextHook} modelCall=${signals.modelCall} sqlite=${signals.sqlite} fts=${signals.fts} vector=${signals.vector} markdown=${signals.markdown}`,
  );
  console.log(`  evidence: ${signals.evidence.slice(0, 3).join(" ") || "none"}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "pool":
    await pool();
    break;
  case "census":
    await census();
    break;
  case "metadata":
    await metadata(rest);
    break;
  case "measure":
    for (const spec of rest) await measure(spec);
    break;
  default:
    console.log(
      "usage: census-peers.ts pool | census | metadata <package...> | measure <package>[@version]...",
    );
}
