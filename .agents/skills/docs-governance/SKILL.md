---
name: docs-governance
description: Doc lanes for this repo. Use when creating or editing README.md, docs/roadmap.md, CHANGELOG.md, the comparison sources, a package README, a changeset, or any file under .agents/; each doc has one job and content never gets copied between them.
---

# Docs governance

Each doc has exactly one job, keep content in its lane:

| File                                                  | Is for                                                                                        | Never contains                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `README.md`                                           | Repo map: the three packages, where to work, the gates, doc links                             | Install, config or usage sections; version history; roadmap; internal rationale |
| `packages/pi/README.md`                               | The adapter's npm landing: what it does, install, commands, config pointers                   | Version history, roadmap, repo map, engine internals                            |
| `packages/opencode/README.md`                         | The OpenCode adapter's npm landing: what it does, install, commands, tools, live loop         | Version history, roadmap, repo map, engine internals                            |
| `packages/*/CHANGELOG.md`                             | Each package's version history, written by changesets                                         | Marketing prose, roadmap                                                        |
| `apps/docs/content/reference/pi/comparison.mdx`       | Audited Pi peer comparison; the page and the source are one file                              | Feature marketing, unverified cells                                             |
| `apps/docs/content/reference/opencode/comparison.mdx` | Audited OpenCode v2 peer comparison; the page and the source are one file                     | Feature marketing, unverified cells                                             |
| `apps/docs/content/reference/deepseek/comparison.mdx` | Audited DeepSeek peer comparison; the page and the source are one file                        | Feature marketing, unverified cells                                             |
| `apps/docs/content/_snippets/**`                      | Shared Markdown or MDX fragments, spliced into the per-harness wrapper pages with `<include>` | Frontmatter, a second full copy of a page, or the other harness's content       |
| `packages/core/README.md`                             | The engine's API: the entry, the two ports, the boundary rule                                 | Pi-specific behaviour, the split's rationale                                    |
| `docs/roadmap.md`                                     | Forward-looking work, evidence gates, rejected items                                          | Shipped-feature history                                                         |
| `.agents/**`                                          | Agent rules, skills, lessons                                                                  | Product docs                                                                    |

## Rules

1. **Never duplicate content across these docs**, package READMEs included, link
   instead. The per-harness guide and reference pages are the one exception in
   form, not in content: `apps/docs/content/_snippets/**` holds the shared
   fragments, plus one partial per harness where the page differs. The wrappers
   under `apps/docs/content/{guides,reference}/{pi,opencode}/*.mdx` hold
   frontmatter and `<include>` statements only. Edit the snippet, never the
   wrapper body.
2. **Version bumps flow through changesets**, run `bun run changeset` with
   your change; `bun run version` generates the CHANGELOG entry. Every changeset
   names the package it bumps in the frontmatter, the engine included: all
   three packages publish, so all three take changesets. Never hand-bump `package.json`
   version for shipped work. The generator in
   `.changeset/config.json` must stay `@changesets/cli/changelog`: the
   `changelog-github` generator aborts `bun run version` without a
   `GITHUB_TOKEN` and a live remote, and this repo has neither (it aborts
   with "We have escaped applying the changesets", consuming nothing).
   The generator also stays local after publication: upstream history is one
   init commit, so the SHAs in the generated `- <sha>: ...` lines name commits
   the public repo does not contain, and a `changelog-github` link built from
   them would 404.
   Consume the pending set with `bun run version` at each milestone; a
   backlog of unconsumed changesets is release notes for releases that were
   never cut. `apps/docs` is private and ships nothing to npm, so a site-only
   change takes no changeset.
3. **Comparison claims are verified against tarballs, dated, and peer-named
   only in the comparison sources.** Check a peer package against its published
   tarball and npm metadata (`npm view <pkg> peerDependencies dependencies
   time.modified`), never against its README, and stamp each source with
   "Last verified: …" before treating a cell as settled. Credit a peer's win in
   the cell: a comparison that shows only our wins is marketing.
   Peer package names appear in
   `apps/docs/content/reference/{pi,opencode,deepseek}/comparison.mdx`, and nowhere else
   in this repo or on the site (owner policy). Those three pages are both the
   audited source and the rendered page: edit a cell there, with its
   verification note and date, never in a second copy. There are no inspiration
   credits: the design cites the LCM paper (algorithmic
   spec) and the smart-zone framing (Matt Pocock) only, because the code is an
   original implementation. The docs site carries no credit line; a concept page
   cites the paper where a mechanism comes from, as
   [how it works](../../../apps/docs/content/concepts/how-it-works.mdx) does.
   Attribution lives in `packages/*/README.md`, the comparison sources, and
   the licence preamble (owner decision).
   The comparison sources are not a spec: a design decision cites a paper section or a
   measured result, never a comparison cell, and a cell that scores a
   mechanism as a peer's cost is not a reason to lack it.
4. **Each published package owns its landing docs.** `packages/<name>/README.md` is
   the landing npm shows, `packages/<name>/CHANGELOG.md` is the version history
   changesets writes in place, and `packages/<name>/LICENSE` is a copy of the root
   licence. The comparisons live in
   `apps/docs/content/reference/{pi,opencode,deepseek}/comparison.mdx`, so the tarball
   no longer ships them. The
   holder named there is the org brand, `stainless-code`, as in every other
   stainless-code package, never a personal name. npm
   always includes `README` and `LICENSE` from the package directory, so the
   adapter's `files` names `dist` plus the changelog npm has to be told about, and
   nothing is copied in at prepack. Keep the shipped docs consumer-appropriate:
   the published tarball's CHANGELOG starts at the first published version, and
   nothing that predates the public init commit appears in it. The engine
   publishes the same way (`lossless-core` 0.1.0): same
   landing docs, same licence copy, `files` names `dist` and its changelog, and
   changesets owns that changelog from the engine's first changeset.
5. Prose standard for any of these files: [`technical-writing`](../technical-writing/SKILL.md) (pick the Diátaxis mode first; README is how-to plus reference, ROADMAP is explanation).

Related: [`../../README.md`](../../README.md) · [`lessons.md`](../../lessons.md).
