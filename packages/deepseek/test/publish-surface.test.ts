import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface Manifest {
  name?: string;
  main?: string;
  files?: string[];
  exports?: Record<string, { types?: string; default?: string }>;
  repository?: { directory?: string };
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

test("publish surface: the tarball carries the build plus README and LICENSE", () => {
  assert.equal(manifest.name, "deepseek-lossless");
  // No CHANGELOG: nothing ships, so no changeset ever cuts one.
  assert.deepEqual((manifest.files ?? []).toSorted(), ["LICENSE", "README.md", "dist"]);
  assert.equal(manifest.exports?.["."]?.default, manifest.main);
  assert.equal(manifest.exports?.["."]?.types, manifest.main?.replace(/\.mjs$/, ".d.mts"));
  assert.equal(manifest.repository?.directory, "packages/deepseek");
  for (const name of ["README.md", "LICENSE"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} is not in the package`);
  }
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});
