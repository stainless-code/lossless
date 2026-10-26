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
  exports?: Record<string, unknown>;
  repository?: { directory?: string };
  icon?: string;
  dsh?: { bundle?: { patch?: string } };
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

test("publish surface: the tarball carries the build, the changelog, and the skill", () => {
  assert.equal(manifest.name, "deepseek-lossless");
  // The changelog starts at the first published version: nothing ships yet,
  // so no changeset has ever cut one. npm always includes README and LICENSE
  // from the package directory, so files names only what npm must be told.
  assert.deepEqual((manifest.files ?? []).toSorted(), [
    "CHANGELOG.md",
    "cordis.patch.yml",
    "dist",
    "docs/DETAIL.md",
    "icon.svg",
    "locale/*.json",
    "skills",
  ]);
  const root = manifest.exports?.["."] as { types?: string; default?: string } | undefined;
  assert.equal(root?.default, manifest.main);
  assert.equal(root?.types, manifest.main?.replace(/\.mjs$/, ".d.mts"));
  const preset = manifest.exports?.["./preset"] as { types?: string; default?: string } | undefined;
  assert.equal(preset?.default, "./dist/preset.mjs");
  assert.equal(preset?.types, "./dist/preset.d.mts");
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

test("publish surface: the bundle manifest resolves through the profile composer", () => {
  assert.equal(manifest.icon, "./icon.svg");
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  for (const subpath of ["./package.json", "./cordis.patch.yml", "./locale/*.json", "./preset"]) {
    assert.ok(manifest.exports?.[subpath] !== undefined, `${subpath} is exported`);
  }
  for (const name of ["cordis.patch.yml", "icon.svg", "locale/en.json", "docs/DETAIL.md"]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} ships in the tarball`);
  }
});

test("publish surface: the host patch switches the backend on install", () => {
  const patch = readFileSync(join(PACKAGE_DIR, "cordis.patch.yml"), "utf8");
  assert.ok(patch.includes("- id: compaction-basic"), "the base row is addressed");
  assert.ok(patch.includes("disabled: true"), "the base backend goes quiet on install");
  assert.ok(patch.includes("- id: deepseek-lossless"), "our row is inserted");
  assert.ok(patch.includes("enabled: true"), "our row mounts enabled");
});

test("publish surface: preset realms live in the web companion package", () => {
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
  const patch = readFileSync(join(PACKAGE_DIR, "cordis.patch.yml"), "utf8");
  assert.ok(!patch.includes("preset-lossless"), "no preset rows in the host patch");
});

test("publish surface: peer ranges admit the pinned prerelease hosts", () => {
  // npm rejects prereleases under "*", so the dsh peers name the rc floor instead.
  const peers = (manifest as { peerDependencies?: Record<string, string> }).peerDependencies ?? {};
  for (const [name, range] of Object.entries(peers)) {
    if (name === "@deepseek-ai/cordis") {
      assert.equal(range, "*");
    } else {
      assert.equal(range, "^0.2.1-rc.3");
    }
  }
});
