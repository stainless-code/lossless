import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ENGINE_SRC = join(REPO_ROOT, "packages", "core", "src");

interface Manifest {
  name?: string;
  main?: string;
  files?: string[];
  keywords?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, { types?: string; default?: string }>;
  repository?: { directory?: string };
  pi?: { extensions?: string[] };
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

test("publish surface: the manifest keeps every field Pi discovers the extension by", () => {
  assert.equal(manifest.name, "pi-lossless");
  // The keyword is what the gallery lists, and the extension block is what Pi loads.
  assert.ok((manifest.keywords ?? []).includes("pi-package"));
  assert.deepEqual(manifest.pi?.extensions, ["./dist/index.mjs"]);
  // Pi loads the file the manifest exports, and the pack builds it from source.
  assert.equal(manifest.pi?.extensions?.[0], manifest.main);
  assert.equal(manifest.exports?.["."]?.default, manifest.main);
  assert.equal(manifest.exports?.["."]?.types, manifest.main?.replace(/\.mjs$/, ".d.mts"));
  assert.ok(existsSync(join(PACKAGE_DIR, "src", "index.ts")));
  assert.equal(manifest.repository?.directory, "packages/pi");
  assert.deepEqual((manifest.files ?? []).toSorted(), ["CHANGELOG.md", "dist"]);
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} is not in the package`);
  }
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});

test("publish surface: the README npm shows is this package's, not the repo map", () => {
  const landing = readFileSync(join(PACKAGE_DIR, "README.md"), "utf8");
  assert.ok(landing.startsWith("# pi-lossless"), landing.slice(0, 40));
  assert.notEqual(landing, readFileSync(join(REPO_ROOT, "README.md"), "utf8"));
  assert.ok(!landing.includes("ROADMAP"), landing);
});

const SHIPPED_DOCS = ["README.md", "CHANGELOG.md"];

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

test("publish surface: a shipped doc links only to what its tarball carries", () => {
  assert.deepEqual(deadLinks("[the roadmap](../../docs/roadmap.md)"), ["../../docs/roadmap.md"]);
  // The comparison moved beside the docs site, so a shipped doc naming it by a
  // relative path is dead by construction, and the README links the site page.
  assert.deepEqual(deadLinks("[the comparison](../../apps/docs/COMPARISON.md)"), [
    "../../apps/docs/COMPARISON.md",
  ]);
  const problems = SHIPPED_DOCS.flatMap((name) =>
    deadLinks(readFileSync(join(PACKAGE_DIR, name), "utf8")).map((link) => `${name}: ${link}`),
  );
  assert.deepEqual(problems, []);
  assert.ok(adapterFiles().length >= 15, `walked ${adapterFiles().length} adapter files`);
});

/** The specifiers one file names, in the three forms this repo writes them. A
 * local copy rather than an import from the engine's boundary test: the adapter
 * reaches the engine through its entry, its tests included. */
const SPECIFIER_PATTERNS = [
  /(?:^|\n)[}\s]*(?:import\s+(?:[^\n]*?\b)?from\s+|from\s+)["']([^"']+)["']/g,
  /(?:^|\n)[}\s]*import\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
];

function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found];
}

function valueSpecifiers(source: string): string[] {
  return specifiers(source.replace(/import\s+type\s[^;]*?from\s*["'][^"']+["']\s*;?/gs, ""));
}

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** The adapter's shipped source and its tests. Its test support is shared with
 * the engine on purpose (one HOME guard); the engine's source is not. */
function adapterFiles(): string[] {
  return [join(PACKAGE_DIR, "src"), join(PACKAGE_DIR, "test")].flatMap((dir) =>
    typescriptFiles(dir),
  );
}

test("publish surface: the adapter reads the engine through its entry and no deeper", () => {
  const problems: string[] = [];
  for (const file of adapterFiles()) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("lossless-core/")) {
        problems.push(`${relative(PACKAGE_DIR, file)} names the deep path ${specifier}`);
      } else if (
        specifier.startsWith(".") &&
        resolve(dirname(file), specifier).startsWith(ENGINE_SRC)
      ) {
        problems.push(`${relative(PACKAGE_DIR, file)} imports the engine's source: ${specifier}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(adapterFiles().length >= 15, `walked ${adapterFiles().length} adapter files`);
});

test("publish surface: every package the adapter imports has a field that declares it", () => {
  // The pack inlines what it can and leaves `peerDependencies` to the host, so an
  // undeclared host package ships Pi's own code inside dist/index.mjs, and a
  // runtime `dependencies` entry would leave the engine out of the tarball.
  const shipped = typescriptFiles(join(PACKAGE_DIR, "src"));
  const imported = new Set(shipped.flatMap((file) => specifiers(readFileSync(file, "utf8"))));
  const atRuntime = new Set(shipped.flatMap((file) => valueSpecifiers(readFileSync(file, "utf8"))));
  const peers = Object.keys(manifest.peerDependencies ?? {});
  const devDependencies = Object.keys(manifest.devDependencies ?? {});
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  for (const name of [...atRuntime].filter(
    (one) => !one.startsWith("node:") && !one.startsWith("."),
  )) {
    // `lossless-core` is the one package the adapter inlines on purpose, and it
    // is the workspace entry below this one.
    if (name === "lossless-core") continue;
    assert.ok(peers.includes(name), `${name} is imported at runtime, so it must be a peer`);
  }
  for (const name of [...imported].filter(
    (one) => !one.startsWith("node:") && !one.startsWith("."),
  )) {
    assert.ok(devDependencies.includes(name), `${name} is imported, so it must be a devDependency`);
  }
  assert.ok(atRuntime.size >= 5, `runtimes found: ${[...atRuntime].join(", ")}`);
});

test("publish surface: the workspace root holds the toolchain, not a package's library", () => {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
  assert.equal(root.dependencies, undefined);
  const toolchain = Object.keys(root.devDependencies ?? {});
  for (const name of toolchain) {
    assert.ok(
      !name.startsWith("@earendil-works/"),
      `${name} belongs to the package that imports it`,
    );
  }
  for (const name of ["lossless-core", "pi-lossless", "typebox"]) {
    assert.ok(!toolchain.includes(name), `${name} is a package dependency, not the root's`);
  }
  for (const name of ["typescript", "vite-plus"]) {
    assert.ok(toolchain.includes(name), `the root's scripts run ${name}`);
  }
});
