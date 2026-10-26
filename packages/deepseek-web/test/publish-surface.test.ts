import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface Manifest {
  name?: string;
  files?: string[];
  exports?: Record<string, unknown>;
  repository?: { directory?: string };
  icon?: string;
  dsh?: { bundle?: { patch?: string } };
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Manifest;

test("publish surface: the web companion ships only the preset layer", () => {
  assert.equal(manifest.name, "deepseek-lossless-web");
  assert.deepEqual((manifest.files ?? []).toSorted(), [
    "CHANGELOG.md",
    "cordis.presets.patch.yml",
    "docs/DETAIL.md",
    "icon.svg",
    "locale/*.json",
  ]);
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.presets.patch.yml");
  assert.equal(manifest.icon, "./icon.svg");
  assert.equal(manifest.repository?.directory, "packages/deepseek-web");
  for (const subpath of ["./package.json", "./cordis.presets.patch.yml", "./locale/*.json"]) {
    assert.ok(manifest.exports?.[subpath] !== undefined, `${subpath} is exported`);
  }
  for (const name of [
    "cordis.presets.patch.yml",
    "icon.svg",
    "locale/en.json",
    "docs/DETAIL.md",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
  ]) {
    assert.ok(existsSync(join(PACKAGE_DIR, name)), `${name} ships in the tarball`);
  }
  assert.deepEqual(
    readFileSync(join(PACKAGE_DIR, "LICENSE")),
    readFileSync(join(REPO_ROOT, "LICENSE")),
  );
});

test("publish surface: the lossless presets mirror the pinned harness presets", () => {
  const patch = readFileSync(join(PACKAGE_DIR, "cordis.presets.patch.yml"), "utf8");
  for (const preset of ["standard", "ptc", "minimal", "cordis"]) {
    assert.ok(
      patch.includes(`id: preset-lossless-${preset}`),
      `lossless ${preset} preset is declared`,
    );
    assert.ok(patch.includes(`id: lossless-${preset}`), `lossless ${preset} identity is set`);
  }
  assert.ok(!patch.includes("- id: compaction-basic"), "no preset keeps the base backend row");
  assert.ok(!patch.includes("\u2014"), "no em dashes in shipped prose");
  assert.ok(
    patch.includes("deepseek-lossless/preset"),
    "the realm backend resolves the sibling entrypoint",
  );
});

test("publish surface: the web companion peers on the host package", () => {
  assert.equal(manifest.peerDependencies?.["deepseek-lossless"], "^0.1.0");
});
