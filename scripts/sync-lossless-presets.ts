import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regenerate packages/deepseek-web/cordis.presets.patch.yml from the pinned
 * harness presets plus the lossless backend swap.
 *
 * Usage: bun scripts/sync-lossless-presets.ts <harness-repo> [--check]
 *
 * The deepseek harness has no narrower preset-override hook: a patch keyed
 * by a preset row id replaces the complete child list, and nested rows are
 * not addressable from later layers (the composer rejects composite ids).
 * So each Lossless preset is a full copy of the shipped preset with exactly
 * two deliberate differences: the compaction group backend becomes
 * deepseek-lossless/preset, and em dashes in copied plan-mode prose read as
 * commas (this repo ships no em dashes). Everything else stays byte for
 * byte, which --check verifies along with regeneration.
 *
 * Re-run against a new harness checkout when the dsh peer floor moves and
 * review the diff: it must show only the backend swap (plus punctuation).
 */

const [, , harnessRepo, flag] = process.argv;
if (harnessRepo === undefined || !existsSync(harnessRepo)) {
  console.error("sync-lossless-presets: pass the deepseek-harness checkout path");
  process.exit(2);
}
const check = flag === "--check";

const PRESETS = [
  { name: "standard", order: 1, losslessOrder: 11 },
  { name: "ptc", order: 2, losslessOrder: 12 },
  { name: "minimal", order: 3, losslessOrder: 13 },
  { name: "cordis", order: 4, losslessOrder: 14 },
] as const;

const BACKEND_OLD = `              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'`;
const BACKEND_NEW = `              - id: deepseek-lossless
                name: deepseek-lossless/preset
                config:
                  enabled: true`;
const EM_DASH_PROSE =
  "Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement \u2014 including an answer confirming something you asked \u2014 approves nothing and does not end plan mode;";
const EM_DASH_FIXED =
  "Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement, including an answer confirming something you asked, approves nothing and does not end plan mode;";

// The harness presets byte that must never drift silently.
const HARNESS_VERSION = JSON.parse(
  readFileSync(join(harnessRepo, "packages", "bundle", "web-app", "package.json"), "utf8"),
).version as string;
if (!HARNESS_VERSION.startsWith("0.2.1-rc.")) {
  console.error(
    `sync-lossless-presets: unexpected harness version ${HARNESS_VERSION}; review the fork`,
  );
  process.exit(2);
}

const out: string[] = [];
out.push(`# Lossless presets: one \`@deepseek-ai/dsh-agent-preset\` declaration per
# shipped web preset, inserted after the web patch. Each entry is generated
# by scripts/sync-lossless-presets.ts from the pinned harness presets
# (dsh v${HARNESS_VERSION}, the runtime our peers admit) with exactly two
# deliberate differences: the compaction group backend becomes
# \`deepseek-lossless/preset\`, and em dashes in copied plan-mode prose read
# as commas (this repo ships no em dashes). Everything else is byte for
# byte the pinned harness preset, so preset sessions keep their catalog
# while compaction runs through the shared lossless core.
#
# Selecting a Lossless preset is the opt-in; the backend row ships enabled
# because the selection itself is the opt-in. The host row stays disabled
# by default, so enable it too: the realm backend borrows the shared core
# and fails fast naming the host row when it is absent.
#`);

for (const { name, order, losslessOrder } of PRESETS) {
  const src = readFileSync(
    join(harnessRepo, "packages", "bundle", "web-app", "presets", `${name}.patch.yml`),
    "utf8",
  );
  let body = src.replace(/^#[^\n]*\n(?:#.*\n)*/, "");
  const idLine = `- id: preset-${name}\n      name: '@deepseek-ai/dsh-agent-preset'`;
  if (!body.includes(idLine))
    throw new Error(`sync-lossless-presets: ${name} entry head not found`);
  body = body.replace(
    idLine,
    `- id: preset-lossless-${name}\n      name: "@deepseek-ai/dsh-agent-preset"`,
  );
  body = body.replace(`id: ${name}\n`, `id: lossless-${name}\n`);
  body = body.replace(`order: ${order}\n`, `order: ${losslessOrder}\n`);
  if (body.split(BACKEND_OLD).length !== 2)
    throw new Error(`sync-lossless-presets: ${name} backend row not found exactly once`);
  body = body.replace(BACKEND_OLD, BACKEND_NEW);
  body = body.split(EM_DASH_PROSE).join(EM_DASH_FIXED);
  // Match the repo formatter (vp check): single-quoted `name:` scalars read
  // as double-quoted. Nothing else is touched: !!js lines are JavaScript
  // and literal-block prose keeps the harness punctuation verbatim.
  body = body
    .split("\n")
    .map((line) =>
      /^(\s*(?:-\s+)?name: )'([^']*)'\s*$/.test(line)
        ? line.replace(/^(\s*(?:-\s+)?name: )'([^']*)'\s*$/, '$1"$2"')
        : line,
    )
    .join("\n");
  if (body.includes("- id: compaction-basic"))
    throw new Error(`sync-lossless-presets: ${name} keeps the base backend`);
  if (body.includes("\u2014"))
    throw new Error(`sync-lossless-presets: ${name} still has an em dash`);
  out.push(body.replace(/\n+$/, ""));
  out.push("");
}

const generated = `${out.join("\n")}`;
const target = join("packages", "deepseek-web", "cordis.presets.patch.yml");
const current = existsSync(target) ? readFileSync(target, "utf8") : null;
if (current === generated) {
  console.log("sync-lossless-presets: in sync");
} else if (check) {
  console.error(
    "sync-lossless-presets: committed presets differ from generated output; re-run without --check",
  );
  process.exit(1);
} else {
  writeFileSync(target, generated);
  console.log("sync-lossless-presets: wrote packages/deepseek-web/cordis.presets.patch.yml");
}
