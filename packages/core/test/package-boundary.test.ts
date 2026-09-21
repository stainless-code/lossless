import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

import * as engine from "../src/index.ts";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC_DIR = join(PACKAGE_DIR, "src");

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  keywords?: string[];
  scripts?: Record<string, string>;
  pi?: unknown;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function entryModules(): string[] {
  const entry = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
  return [...entry.matchAll(/^export \* from "\.\/(.+?)\.ts";$/gm)].map((match) => match[1]!);
}

function namedIn(clause: string): string[] {
  return clause
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

test("package: the engine depends on its schema library and nothing else", () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["typebox"]);
  assert.equal(manifest.peerDependencies, undefined);
  for (const field of DEPENDENCY_FIELDS) {
    const named = Object.keys(manifest[field] ?? {});
    assert.deepEqual(
      named.filter((name) => name.startsWith("@earendil-works/") || name === "pi-lossless"),
      [],
      `${field} names the adapter or the Pi SDK`,
    );
  }
  assert.deepEqual(Object.keys(manifest.exports ?? {}), ["."]);
  assert.equal(manifest.pi, undefined);
  assert.ok(!(manifest.keywords ?? []).includes("pi-package"));
});

test("package: the engine is publishable, and ships dist plus the docs it owns", () => {
  assert.equal(manifest.name, "lossless-core");
  assert.equal(manifest.private, undefined);
  // npm always includes README and LICENSE from the package directory, so the
  // file list names only what it has to be told about. changesets writes the
  // changelog in place, as it does for the adapter.
  assert.deepEqual(manifest.files, ["dist", "CHANGELOG.md"]);
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} is not in the package`);
  }
  // The root keeps the repo's licence; the package ships the same bytes.
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});

const SHIPPED_DOCS = ["README.md", "CHANGELOG.md"];

/** The links in a shipped doc that resolve outside the package or to a file it
 * does not carry. An npm reader has the tarball and nothing around it, so both
 * fail for them. */
function deadLinks(source: string): string[] {
  const dead: string[] = [];
  for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const resolved = resolve(PACKAGE_DIR, target.split("#")[0]!);
    if (relative(PACKAGE_DIR, resolved).startsWith("..") || !existsSync(resolved)) {
      dead.push(target);
    }
  }
  return dead;
}

test("package: a shipped doc links only to what its tarball carries", () => {
  // A planted violation, so a walk that finds nothing is known to work rather
  // than known to be silent, and an inside link it has to leave alone.
  assert.deepEqual(deadLinks("[the roadmap](../../docs/roadmap.md)"), ["../../docs/roadmap.md"]);
  assert.deepEqual(deadLinks("[the changelog](./CHANGELOG.md)"), []);
  const problems = SHIPPED_DOCS.flatMap((name) =>
    deadLinks(readFileSync(join(PACKAGE_DIR, name), "utf8")).map((link) => `${name}: ${link}`),
  );
  assert.deepEqual(problems, []);
});

test("package: the entry re-exports every module, and only modules that exist", () => {
  const modules = entryModules();
  const onDisk = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .map((name) => name.slice(0, -".ts".length));
  assert.deepEqual([...modules].sort(), [...onDisk].sort());
  assert.ok(modules.includes("host"), modules.join(", "));
});

test("package: every name the engine's README promises is exported", () => {
  const readme = readFileSync(join(PACKAGE_DIR, "README.md"), "utf8");
  const imports = [...readme.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+"lossless-core"/g)];
  const values = imports
    .filter(([, kind]) => kind === undefined)
    .flatMap(([, , names]) => namedIn(names!));
  // A type import is erased at runtime, so it is checked against the source
  // that declares it; `bun run typecheck` reads the import itself.
  const types = imports
    .filter(([, kind]) => kind !== undefined)
    .flatMap(([, , names]) => namedIn(names!));
  const source = readdirSync(SRC_DIR)
    .map((name) => readFileSync(join(SRC_DIR, name), "utf8"))
    .join("\n");
  for (const name of values) {
    assert.ok(name in engine, `the README imports ${name}, which the entry does not export`);
  }
  for (const name of types) {
    assert.match(
      source,
      new RegExp(`export (interface|type) ${name}\\b`),
      `the README imports the type ${name}, which nothing declares`,
    );
  }
  assert.ok(values.length >= 3, `README value imports found: ${values.length}`);
  assert.ok(types.length >= 2, `README type imports found: ${types.length}`);
});

test("workspace: one test runner, and no Bun test config", () => {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
  assert.equal(root.scripts?.test, "vp test", "the root test script must be the one runner");
  assert.equal(
    existsSync(join(REPO_ROOT, "bunfig.toml")),
    false,
    "a Bun test config would run the suite under a second runner with no setupFiles",
  );
});
