---
name: verify-after-each-step
description: The gates to run after a change and before a commit in this repo, with the exact commands: vp check, bun run test, bun run typecheck, bun run pack, and the coverage commands. Use after any slice, plan item, fix, or doc edit, or when asked whether the tree is green.
---

# Verify after each step

After completing a step, verify every file you touched, don't wait for
`git commit`.

## What counts as a step

Tracer-bullet slice, plan TODO, refactor, module/entry/hook change, bug fix,
doc change, config change.

## Gates (exact commands)

1. **Any change**: `vp check` (format, type-aware lint, and tsgo type check; `lint.options.typeCheck` in `vite.config.ts` turns the last one on), or `vp check --fix` then re-run when it reports fixes.
2. **`packages/*/src/**` changed**: `bun run test` (Vitest through Vite+), every
   test green before moving on. That is the repo's only runner and there is no Bun
   test config: bare `bun test` collects the same files under Bun's runner with no
   `setupFiles`, which reports a false green for a file that never isolated HOME
   and dozens of failures that are runner artifacts rather than defects.
3. **`packages/*/src/**` or `packages/*/test/**` changed**: `bun run typecheck` (`tsc --noEmit`),
   the same check CI runs, as a second opinion on tsgo.
4. **`package.json` / packaging changed**: `bun run pack` and, before any
   publish, `npm publish --dry-run` to inspect the tarball.
5. **Coverage-relevant**: `bun run test:coverage` (portable, CI gate), then
   `bun run coverage:codemap` (local codemap ingest) and check
   `codemap dead-code` stays empty.

## Rules

- Fix before moving on, never carry forward known failures.
- Never commit with a red gate; never add `.gitignore` entries in the same
  commit as the files they should have excluded.
- A gate piped into `tail` reports `tail`'s exit status, so a background task
  dock can call a failed build a success: run the gate bare or redirect to a
  file and check the code.

Related: [`../../lessons.md`](../../lessons.md) · [`../docs-governance/SKILL.md`](../docs-governance/SKILL.md).
