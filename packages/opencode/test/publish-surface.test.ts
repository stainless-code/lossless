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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, { types?: string; default?: string }>;
  repository?: { directory?: string };
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

test("publish surface: the manifest names the built entry and its own docs", () => {
  assert.equal(manifest.name, "opencode-lossless");
  assert.equal(manifest.main, "./dist/index.mjs");
  assert.equal(manifest.exports?.["."]?.default, manifest.main);
  assert.equal(manifest.exports?.["."]?.types, "./dist/index.d.mts");
  assert.equal(manifest.repository?.directory, "packages/opencode");
  assert.deepEqual((manifest.files ?? []).toSorted(), ["CHANGELOG.md", "dist", "skills"]);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} is not in the package`);
  }
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});

/** The specifiers one file names, in the three forms this repo writes them. */
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

test("publish surface: the host API is imported type-only", () => {
  const problems: string[] = [];
  for (const file of typescriptFiles(join(PACKAGE_DIR, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const specifier of valueSpecifiers(source)) {
      if (specifier.startsWith("@opencode/")) {
        problems.push(`${relative(PACKAGE_DIR, file)} value-imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("publish surface: the adapter reads the engine through its entry and no deeper", () => {
  const files = [join(PACKAGE_DIR, "src"), join(PACKAGE_DIR, "test")].flatMap((dir) =>
    typescriptFiles(dir),
  );
  const problems: string[] = [];
  for (const file of files) {
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
  assert.ok(files.length >= 15, `walked ${files.length} adapter files`);
});

test("publish surface: every imported package is declared for the build", () => {
  const shipped = typescriptFiles(join(PACKAGE_DIR, "src"));
  const imported = new Set(shipped.flatMap((file) => specifiers(readFileSync(file, "utf8"))));
  const devDependencies = Object.keys(manifest.devDependencies ?? {});
  for (const name of [...imported].filter(
    (one) => !one.startsWith("node:") && !one.startsWith("."),
  )) {
    assert.ok(devDependencies.includes(name), `${name} is imported, so it must be a devDependency`);
  }
});

test("publish surface: a built bundle and its declarations name no host SDK", () => {
  for (const name of ["index.mjs", "index.d.mts"]) {
    const file = join(PACKAGE_DIR, "dist", name);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("@opencode/"), `${name} imports the host SDK`);
    assert.ok(!source.includes("lossless-core/src/"), `${name} imports the engine source`);
  }
});
