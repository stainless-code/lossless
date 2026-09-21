---
name: docs-voice
description: Voice and pipeline for the published docs site (apps/docs): headings that carry the point, claims with their consequence, routing indexes, published anchors, and the blume build, validate and audit order. Use when editing a docs page or content file, rewriting home copy, renaming a linked heading, running a docs voice pass, or validating the built site.
---

# Docs voice

`apps/docs` is the product's long-form surface, and a visitor reads the heading list before deciding to read anything else. This skill is [`technical-writing`](../technical-writing/SKILL.md) applied to that surface, plus the site's own build order. [`unslop`](../unslop/SKILL.md) owns the pattern catalog, and root docs stay [`docs-governance`](../docs-governance/SKILL.md)'s lane.

**A voice pass changes voice, never facts.** Every default, path, command, limit and number stays byte-identical unless that fact is the point of the change. A count needs the command that regenerates it.

## Surfaces and their modes

| Surface                              | Mode        | Boundary                                                                  |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `pages/_home/*`, `pages/index.astro` | copy        | Opinion and pitch are allowed. No claim the page cannot show.             |
| `content/concepts/**`                | explanation | Opinion allowed. A heading tolerates "About ..." in front.                |
| `content/guides/**`                  | how-to      | Commands, conditions, expected output. No teaching.                       |
| `content/reference/**`               | reference   | Dry. No "you", no persuasion, spec tables only.                           |
| `content/reference/comparison.mdx`   | generated   | Never hand-edited; `apps/docs/COMPARISON.md` is the only writer's source. |
| `content/**/index.mdx`               | routing     | Help the reader choose, do not summarize.                                 |

## Headings carry the point

- The heading names the outcome or the claim, not the topic. Read the headings alone, top to bottom: they should walk the page's argument, not its table of contents.
- A task heading is a bare verb phrase. A concept heading is a noun phrase. A copy heading may be a full claim.
- Number the sections only where order matters. Elsewhere a number promises a sequence that is not there.
- Sentence case, one `h1`, no skipped levels.
- Check a section or card heading against the body under it. A heading its own body contradicts is a defect, not a style choice.
- Never rename a heading whose slug another page links to. Keep the new text and pin the old slug: `## Big tool results become file handles [#file-handles]`.

## Every claim carries its consequence

- After a default, say what the reader sees: the prompt change, the log line, the file on disk. A default with no visible effect reads as trivia.
- Prefer the observable noun: the real key, flag, command, path or screen text, over "the value", "the projection", "the mechanism".
- A capability is a term plus the gain it buys, not the term restated.
- Give a limit a reader. A limits section that names who it does not affect is stronger than one that hedges every claim.
- An index page routes by the reader's state, not by the feature list: start here if X, read that if Y.
- A link carries its purpose: the page name plus what following it gets the reader.

## Cut what would fit another product

- A sentence that could sit unchanged in a competitor's docs says nothing about this one. Replace it with the mechanism or the number.
- No marketing adjectives, no pre-announcements, no promises about future work. Limits are stated once, on the limits page.
- Vary sentence length. Three clipped claims in a row read as generated copy; a longer sentence carrying a condition is fine.
- Two contrast constructions ("X, not Y") per page at most. [`unslop`](../unslop/SKILL.md) bans the mannered forms; the plain one is allowed by volume, not by rule.

## Anchors are published

An anchor is a URL, so it outlives the heading text that produced it. Seven anchors are linked from another page today. Four are pinned with the bracket form (`#file-handles`, `#derived-text`, `#metrics`, `#redaction`); three ride on their heading's own slug (`#reporting-a-problem`, `#rebuild-or-remove`, `#the-gauge-disagrees-with-pi`). Before renaming a heading, search for its slug:

```sh
rg -n '#the-old-slug' apps/docs
```

If anything links to it, take the new text and pin the slug.

## Tensions already resolved

- Explanation headings: Diátaxis favors the label, this repo's top rule favors the claim. Pages that read as "about X" keep labels; pages that are a sequence of mechanisms use claims. Do not churn the registers together for the sake of consistency.
- The reference lane stays dry on pages where a concept page persuades. The two registers are deliberate.

## The build order

`blume audit` reads the built `apps/docs/dist`, and an isolated build omits `robots.txt` and `llms.txt`, so an isolated build cannot be audited. A non-isolated build refuses to run while `blume dev` is up.

1. Stop the dev server.
2. From `apps/docs`: `rm -rf dist && bunx blume build`.
3. `bunx blume validate --strict`.
4. `bunx blume audit --fail-on error`.
5. Restart `bunx blume dev`.

The pass is done when the audit reports zero errors, validate passes strict, and the headings still walk each page.
