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

test("publish surface: the tarball carries the build, the changelog, and the skill", () => {
  assert.equal(manifest.name, "deepseek-lossless");
  // The changelog starts at the first published version: nothing ships yet,
  // so no changeset has ever cut one. npm always includes README and LICENSE
  // from the package directory, so files names only what npm must be told.
  assert.deepEqual((manifest.files ?? []).toSorted(), ["CHANGELOG.md", "dist", "skills"]);
  assert.equal(manifest.exports?.["."]?.default, manifest.main);
  assert.equal(manifest.exports?.["."]?.types, manifest.main?.replace(/\.mjs$/, ".d.mts"));
  assert.equal(manifest.repository?.directory, "packages/deepseek");
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} is not in the package`);
  }
  assert.ok(existsSync(join(PACKAGE_DIR, "skills", "deepseek-lossless", "SKILL.md")));
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});
