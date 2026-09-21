import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

const CORE_DIR = fileURLToPath(new URL("../src", import.meta.url));
const HOST_SDK = "@earendil-works/";
/** The bare specifiers a core module may name: the runtime, and the schema
 * library a reader tool declares its parameters with. */
const ALLOWED_PREFIXES = ["node:", "typebox"];

/**
 * The specifiers one source file imports, in the forms this repo writes:
 * `import x from "y"`, a multi-line close `} from "y"`, a side-effect
 * `import "y"`, and a dynamic `import("y")`. A `from` inside prose is
 * deliberately not one of them, which is why the keyword has to start a line.
 */
export function importedBy(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /(?:^|\n)[}\s]*(?:import\s+(?:[^\n]*?\b)?from\s+|from\s+)["']([^"']+)["']/g,
    /(?:^|\n)[}\s]*import\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return [...found];
}

export function violations(path: string, source: string): string[] {
  const problems: string[] = [];
  for (const specifier of importedBy(source)) {
    if (specifier.startsWith(HOST_SDK)) {
      problems.push(`${path} names the host SDK: ${specifier}`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const inside = relative(CORE_DIR, resolve(dirname(path), specifier));
      if (inside.startsWith("..") || isAbsolute(inside)) {
        problems.push(`${path} imports outside the core: ${specifier}`);
      }
      continue;
    }
    if (ALLOWED_PREFIXES.some((prefix) => specifier.startsWith(prefix))) continue;
    problems.push(`${path} names a bare specifier the core may not use: ${specifier}`);
  }
  return problems;
}

function coreFiles(dir = CORE_DIR): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...coreFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("boundary: no core module names the host SDK", () => {
  const files = coreFiles();
  for (const file of files) {
    assert.deepEqual(
      violations(file, readFileSync(file, "utf8")),
      [],
      `${relative(CORE_DIR, file)} breaks the core boundary`,
    );
  }
});

/** A check that walks nothing passes everything, so the walk has a floor and
 * the port itself has to be in it. */
test("boundary: the walk reaches the core, the port included", () => {
  const names = coreFiles().map((file) => relative(CORE_DIR, file));
  assert.ok(names.length >= 25, `walked ${names.length} core files`);
  for (const name of ["host.ts", "llm.ts", "retrieval.ts", "diagnose.ts"]) {
    assert.ok(names.includes(name), `${name} is missing from the walk: ${names.join(", ")}`);
  }
});

/** The other direction: the extractor can see the SDK in the shapes a host file
 * writes, so a green boundary run is not a blind one. (The adapter's own suite
 * is what proves the real host files name it.) */
test("boundary: the extractor sees the SDK in host-shaped sources", () => {
  const hostShaped = [
    'import type { AssistantMessage, Message } from "@earendil-works/pi-ai";',
    "import type {",
    "\tExtensionContext,",
    '} from "@earendil-works/pi-coding-agent";',
    "",
  ].join("\n");
  assert.deepEqual(
    importedBy(hostShaped).filter((specifier) => specifier.startsWith(HOST_SDK)),
    ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  );
});

test("boundary: the rule rejects each thing it exists to catch", () => {
  const here = join(CORE_DIR, "synthetic.ts");
  assert.deepEqual(violations(here, 'import type { Context } from "@earendil-works/pi-ai";\n'), [
    `${here} names the host SDK: @earendil-works/pi-ai`,
  ]);
  assert.deepEqual(violations(here, 'import { piReader } from "../host/pi.ts";\n'), [
    `${here} imports outside the core: ../host/pi.ts`,
  ]);
  assert.deepEqual(violations(here, 'import { z } from "zod";\n'), [
    `${here} names a bare specifier the core may not use: zod`,
  ]);
  assert.deepEqual(
    importedBy('import "a";\nvoid import("b");\nimport {\n\tc,\n} from "d";\n').sort(),
    ["a", "b", "d"],
  );
  assert.deepEqual(importedBy(' * a reader can tell "not collected" from "not installed".\n'), []);
});

/** Store writes only the repair pass may use: the orphan sweeps, the dedupe,
 * the dead-run reap, and the index rebuild. Tests name them too, and the walk
 * below only sees src, so a test call never trips this. */
const REPAIR_METHODS = [
  "rebuildFts",
  "deleteOrphanSpans",
  "dedupeSpans",
  "reapDeadRuns",
  "deleteOrphanChildren",
];

function repairCallers(): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const file of coreFiles()) {
    const source = readFileSync(file, "utf8");
    for (const method of REPAIR_METHODS) {
      if (new RegExp(`\\.${method}\\s*\\(`).test(source)) {
        const name = relative(CORE_DIR, file);
        callers.set(method, [...(callers.get(method) ?? []), name]);
      }
    }
  }
  return callers;
}

test("boundary: repair-only store methods are called from the repair pass alone", () => {
  const callers = repairCallers();
  for (const method of REPAIR_METHODS) {
    assert.deepEqual(
      callers.get(method) ?? [],
      ["integrity.ts"],
      `${method} has a caller outside the repair pass`,
    );
  }
});

/** The compaction depth cap: no module that invokes the compaction pass may name
 * it, so the shipped passes always run uncapped and only tests set it.
 * (sessions.ts has its own unrelated walk-depth option of the same name.) */
test("boundary: no caller of the compaction pass sets the depth cap", () => {
  const setters = coreFiles()
    .filter((file) => !file.endsWith("compaction-engine.ts"))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return /\brunCompaction\b|\bcondensationGroup\b/.test(source) && /\bmaxDepth\b/.test(source);
    })
    .map((file) => relative(CORE_DIR, file));
  assert.deepEqual(setters, []);
});
