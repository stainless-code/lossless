---
name: docs-sync
description: Audit documentation against shipped behavior and update only factually stale pages. Use after a release or a command, config, CLI, API, default, path, or workflow change; when asked to check docs for drift, refresh stale docs, or run a scheduled docs audit.
---

# Docs sync

Keep `apps/docs`, the package READMEs, and the root docs true to what shipped. This is maintenance, not authorship: find claims the code no longer supports, fix exactly those, and verify the docs site. [`docs-governance`](../docs-governance/SKILL.md) owns which doc holds what; [`docs-voice`](../docs-voice/SKILL.md) owns voice, anchors, and the site build order.

## Ground rules

- Document only behavior that is in the repository now. Work behind a disabled flag is not public documentation.
- Facts over polish: a wrong default, flag, path, version, limit, provider, or required step is a docs bug; a wording preference is not.
- Copy exact identifiers and values from code. Do not paraphrase a command, key, default, or environment variable.
- Touch the fewest pages that remove the drift. Preserve the surrounding structure, components, and anchors.
- Do not edit generated output (`dist/`, `.blume/`). Do not overwrite unrelated local changes.
- A run that finds nothing actionable ends with a short report and no commit.

## Workflow

1. **Set the scope.** Read `AGENTS.md`, [`docs-governance`](../docs-governance/SKILL.md), and [`docs-voice`](../docs-voice/SKILL.md). Honor a lookback window, docs path, or report-only request from the user. With no window, compare against changes since the last docs update or the last stable milestone.
   Sources: `git log`, `.changeset/**`, `packages/*/CHANGELOG.md`, package entry points and config schemas, CLI help, environment variables, routes, and the docs under `apps/docs/content/**`, `_snippets/**`, package READMEs, `README.md`, and `docs/roadmap.md`.
   Done when every changed public fact has a source and either a docs target or a recorded reason it is internal.

2. **Find drift.** Compare facts, not prose:
   - A command, flag, config key, environment variable, route, prop, exported API, default, path, or version changed.
   - A shipped capability is absent from the page that should describe it.
   - A page promises a provider, adapter, integration, or workflow the code no longer supports.
   - A required step disappeared, or an example no longer runs.
   - A linked page or heading moved, so the link or anchor is stale.
   - An external link the page depends on points at a dead or superseded primary source.
   - A release or changeset needs a user-facing entry.

   Skip subjective rewording, voice work, speculative future work, duplicated content, and formatting churn. Send wording-only changes through [`docs-voice`](../docs-voice/SKILL.md).

3. **Edit the owning surface.** Update the snippet or source file, never a generated wrapper. Keep package READMEs in their own lane. Do not copy the same fact into several docs; link instead. Preserve published anchors by pinning the old slug when a linked heading must change.

4. **Verify.**
   - From the repo root: `vp check`.
   - From `apps/docs`: `bun run check --isolated` while a dev server may be running. A missing `GITHUB_TOKEN` warning is an environment warning, not a docs failure; report it as such.
   - If the change adds, removes, or renames a page or heading, or changes site navigation, follow the full build, validate, and audit order in [`docs-voice`](../docs-voice/SKILL.md).
   - Fix failures caused by this edit. Report pre-existing failures separately.

5. **Deliver.** This repo commits on `main`, one commit per stable milestone, with a changeset for user-visible package change. A report-only audit or a no-op creates no branch and no commit. When edits are needed, make one focused commit and state what was checked, what changed, what was verified, what was skipped, and what risk remains.

## Done means

- Every changed public fact is either corrected in its owning doc or explicitly recorded as internal.
- The diff is the smallest set of factual corrections.
- `vp check` passes and the docs check passes, or the remaining failure is named and shown to predate the edit.
- A no-op run has no edits and reports the areas checked.
