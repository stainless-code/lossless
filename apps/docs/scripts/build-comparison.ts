/**
 *
 * `COMPARISON.md` is the audited source; this page is its projection. Cells are
 * never restated here, and peer names appear in exactly two files: that one and
 * this generated page (see the `docs-governance` skill).
 *
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const sourcePath = resolve(repoRoot, "apps/docs/COMPARISON.md");
const outputPath = resolve(here, "../content/reference/comparison.mdx");

const REPO = "https://github.com/stainless-code/lossless";
const BLOB = `${REPO}/blob/main`;

/** Anything absent fails the run. */
const SECTIONS: readonly { heading: string; intro?: string }[] = [
  { heading: "One matrix on the same axes" },
  { heading: "What each one wins" },
  {
    heading: "Where the field is ahead of this package",
    intro:
      "What remains open against this field, verified in peer source, followed by the gaps this package keeps on purpose.",
  },
  { heading: "By design, not missing" },
  { heading: "When to pick which" },
  { heading: "Do not run two engines in one session" },
];

const source = readFileSync(sourcePath, "utf8");

const verifiedMatch = /^Last verified: (\d{4}-\d{2}-\d{2})\.$/mu.exec(source);
if (verifiedMatch === null) {
  throw new Error(`${sourcePath} has no "Last verified: YYYY-MM-DD." line`);
}
const verified = verifiedMatch[1];

const sections = new Map<string, string>();
{
  const lines = source.split("\n");
  let current: string | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== undefined) sections.set(current, buffer.join("\n").trim());
  };
  for (const line of lines) {
    const heading = /^## (.+)$/u.exec(line);
    if (heading !== null) {
      flush();
      current = heading[1]!.trim();
      buffer = [];
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();
}

/** The source's own directory is the base, so a link the doc writes for its
 * neighbours (`../../docs/roadmap.md`) resolves to the path GitHub serves. */
const rewriteLinks = (text: string): string =>
  text.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/gu, (match, label: string, target: string) => {
    if (target.startsWith("http")) return match;
    const repoPath = relative(repoRoot, resolve(dirname(sourcePath), target));
    if (repoPath.startsWith("..")) return label;
    if (
      /^(?:packages\/[a-z]+\/)?(COMPARISON|CHANGELOG|README)\.md$|^docs\/roadmap\.md$/u.test(
        repoPath,
      )
    ) {
      return `[${label}](${BLOB}/${repoPath})`;
    }
    // No site route exists for the target: keep the words, drop the dead link.
    return label;
  });

const body = SECTIONS.map(({ heading, intro }) => {
  const section = sections.get(heading);
  if (section === undefined) {
    throw new Error(`COMPARISON.md has no "## ${heading}" section`);
  }
  const rest = intro === undefined ? section : section.replace(/^[\s\S]*?\n\n/u, `${intro}\n\n`);
  return `## ${heading}\n\n${rewriteLinks(rest)}`;
}).join("\n\n");

const page = `---
title: Comparison
description: "pi-lossless against the four Pi compaction engines it competes with: one shared matrix, where each engine leads, and the gaps this package keeps."
search:
  tags: ["reference", "comparison"]
---

A Pi session can run one compaction engine, so the useful question is not which
package is best but which mechanism it implements. This page is the site
projection of [COMPARISON.md](${BLOB}/apps/docs/COMPARISON.md), the audited source
beside this site.

Every cell was read from the engine's source, never from a project's README.
Peer packages are named here and in \`COMPARISON.md\`, nowhere else in these docs.

Verified ${verified}. Numbers move, so check that date before quoting a cell.
Everything below is generated from \`COMPARISON.md\` by
\`apps/docs/scripts/build-comparison.ts\`; correct that file, not this page.

${body}

## Method

The line audits, the engine commits, and the reproduction steps are in
[COMPARISON.md](${BLOB}/apps/docs/COMPARISON.md).
`;

writeFileSync(outputPath, page, "utf8");
console.log(
  `[comparison] ${SECTIONS.length} sections, verified ${verified} -> content/reference/comparison.mdx`,
);
