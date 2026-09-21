# Harden PR workflow

**Goal:** pristine production state on in-scope paths, shippable, verified, and documented, **without** changing PR intent or runtime behavior.

## Run-to-completion (read first)

**NEVER** stop between passes to ask whether to commit, whether to continue, or whether to spawn another reviewer. **ONLY** allowed mid-loop question: intent anchor step 3 when plan doc and commit range both fail to state what must not change. Otherwise: resolve anchor → run all passes → fix → verify → next pass → finish → report.

| Phase           | Behavior                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **During loop** | Autonomous. `Task`-batch readonly reviewers in parallel, merge JSON findings, vet, fix in-bounds, re-run checks, advance pass counter.       |
| **After loop**  | Single concise report: mode, passes run, production-bar status (met / gaps), fixes made, checks status, deferred nits (if any).              |
| **Commit**      | If there are uncommitted fixes: one `harden: …` commit **without asking**, because skill invocation authorizes it. If no fixes: skip commit. |

## Modes

| Mode          | When                                                                                                                                  | Scope                     | Max passes |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------- |
| **Lite**      | After each plan-milestone or slice commit                                                                                             | Files in the slice diff   | 2          |
| **Quick**     | Cheap uncertainty pass ("quick harden")                                                                                               | Last commit or slice diff | 1          |
| **Full**      | User intent ("full harden", "PR done", "production-ready pass") **or** offer when the current `docs/roadmap.md` open item is complete | `origin/main...HEAD`      | 3          |
| **Reconcile** | `/harden-pr reconcile`: process `LEDGER.md` § Deferred (skip when the file is absent), then run **full** if branch still open         | `origin/main...HEAD`      | 3          |

Default to **lite** when invoked immediately after a slice commit. Default to **full** when the user signals branch completion. **Quick** = core 3 reviewers only (no extended roster).

**Scope base.** `origin/main...HEAD` is the base for a pushed branch. Work
committed straight to `main` has no range: take the milestone commit before this
change as the base (`git rev-parse <commit>`) and substitute that SHA wherever
`origin/main` appears below.

## Production bar (what "pristine" means)

| Area            | Pristine =                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Correctness** | No known bugs or unhandled edge cases in changed paths; behavior matches intent anchor                                                                                                                           |
| **Tests**       | Changed behavior covered; `bun run test` passes; store and compaction tests run against the real in-memory `LcmStore`, not a fake                                                                                |
| **Checks**      | Format, lint, typecheck clean on touched files ([`verify-after-each-step`](../verify-after-each-step/SKILL.md)); `bun run pack` clean if a package's `src/index.ts`, `vite.config.ts`, or `package.json` changed |
| **Public API**  | New/changed exports carry JSDoc that reads well in hovers + published typings; `@default` / `@example` survive into `.d.mts`; no maintainer internals leaked into the root README or changesets                  |
| **Docs**        | User-visible changes reflected in root `README.md`, changesets, ROADMAP/CHANGELOG with no drift; doc lanes per [`docs-governance`](../docs-governance/SKILL.md)                                                  |
| **Structure**   | No boundary violations in the diff (`packages/core` imports nothing from `packages/pi` or the Pi SDK; peers stay external in `dist/index.mjs`; no cycles)                                                        |
| **Hygiene**     | No dead code, TODO slop, or sloppy naming in touched files; errors actionable                                                                                                                                    |
| **Ship shape**  | A reviewer could merge without "fix before ship" notes (except deferred out-of-scope nits)                                                                                                                       |

If a finding moves the bar toward pristine and stays in-bounds → **fix it**, including nits in touched files.

## Intent anchor (every reviewer prompt includes this)

Resolve in order; stop at the first hit:

1. **Stated intent**: the goal and non-goals in the commit message that landed
   the change, or the `docs/roadmap.md` item it closes
2. **Commit range**: `git log --oneline origin/main...HEAD` + `git diff --name-status origin/main...HEAD`
3. **User anchor**: ask once, "What must not change?" (1 to 2 sentences). **Only step that may interrupt the loop.**

Reviewers treat the anchor as contract. Findings that would violate it → **report, do not apply**. Record `HEAD` at loop start (`git rev-parse HEAD`) in the final report.

## Vet step (parent, after merge, before fix)

Subagents over-report. After merge + dedupe:

1. Read `LEDGER.md` § Rejections when the file is present. Drop findings matching a rejection entry.
2. For each remaining finding: **re-read** `file` at `line` (or the cited region). Drop if the claim is false or by-design.
3. New by-design drops → append one bullet to **§ Rejections** in `LEDGER.md`, creating the file with that heading when it is absent.
4. Sort survivors: `severity` first, then `confidence` desc, then `effort` asc.

**Anti-pattern:** applying a fix without re-reading the cited location.

## Reconcile mode

Run-to-completion like other modes:

1. Read `LEDGER.md` § Deferred when the file is present. Re-vet each row (same vet step). Fix in-bounds items; remove fixed lines.
2. Run **full** harden on `origin/main...HEAD`.
3. On cap: append still-deferred items to **§ Deferred** in `LEDGER.md`, creating the file when it is absent. Report what was reconciled vs still open.

## In-bounds vs out-of-bounds

**Fix:** bugs, missing tests, docs/changeset drift, lint/type/format, error-handling gaps, edge cases, behavior-preserving refactors in touched files, in-scope nits (naming, comment hygiene).

**Report only:** redesign, semantic API changes, nits outside the diff, refactors unrelated to a flagged issue.

## Spawning subagents (non-negotiable)

The parent agent **MUST NOT** perform reviewer duties inline. Every pass **starts** with a parallel `Task` batch; grep/read/diff by the parent is setup only.

Children inherit the parent session's cwd, not the repo. When the session runs outside the repo, pass the repo path as each child's `cwd`, or the children die mid-read and return no findings.

### Finding schema (every reviewer returns this)

Each reviewer returns **only** a JSON array (no prose wrapper).

```json
{
  "finding": "One-sentence claim about a gap vs production bar",
  "severity": "blocker | major | minor | nit | info",
  "file": "repo-relative/path or \"multiple\"",
  "line": 42,
  "confidence": "high | medium | low",
  "effort": "S | M | L",
  "fixable_in_bounds": true,
  "production_bar": "Tests | Docs | Public API | …"
}
```

Use `line: null` when the gap is file-level.

**Severity → action**

| Severity                   | Parent action                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| `blocker` / `major`        | Fix in pass 1; must fix or defer with plan non-goals before done |
| `minor` / `nit`            | Fix when in touched files; pass 2+ if pass 1 was crowded         |
| `info`                     | Log only unless zero-cost fix in diff                            |
| `fixable_in_bounds: false` | Final report deferred list. Do not apply                         |

**Merge + dedupe (parent, after each batch)**

1. Concatenate reviewer arrays. 2. Drop `info` unless it blocks ship shape. 3. Dedupe: same `file` + root cause → keep highest severity, merge `finding` text. 4. Sort: `blocker` → `major` → `minor` → `nit`; within tier → `confidence` desc → `effort` asc. 5. **Vet** (§ Vet step). 6. If vetted list empty → pass succeeds; skip fix phase.

### Reviewer prompt template (copy per `Task`)

Fill `{ROLE}`, `{INTENT_ANCHOR}`, `{SCOPE}`, `{EXTRA}`; set `subagent_type: "generalPurpose"` (or `explore`), `readonly: true`.

```text
You are the **{ROLE}** reviewer for `/harden-pr` on `lossless` (a pi coding-agent extension: SQLite+FTS5 store, DAG summaries, recall tools).

**Intent anchor (contract, do not suggest changes that violate):**
{INTENT_ANCHOR}

**Scope:** {SCOPE}
(lite: slice diff files; full: `git diff --name-status origin/main...HEAD`)

**Production bar:** See harden-pr WORKFLOW.md § Production bar. Optimize for {ROLE} rows.

**Task:** {EXTRA}

**Return ONLY** a JSON array of findings:
[{ "finding": "...", "severity": "blocker|major|minor|nit|info", "file": "...", "line": N|null, "confidence": "high|medium|low", "effort": "S|M|L", "fixable_in_bounds": true|false, "production_bar": "..." }]
If clean: []

Read-only. Do not edit files.
```

### Reviewer roster

Spawn applicable reviewers **in parallel** via **`Task`** in **one batch per pass**.

**Core (always, every pass):**

1. **Correctness**: bugs, edge cases, missing tests in changed paths; run `bun run test`. Apply [`interrogate/RUBRIC.md`](../interrogate/RUBRIC.md) and [`interrogate/CODE-QUALITY.md`](../interrogate/CODE-QUALITY.md) as the lens.
2. **Ship-readiness**: docs / changeset / README drift; grep inbound refs to deleted files; verify a lifted rule reached its anchor doc; cross-ref anchors; run [`verify-after-each-step`](../verify-after-each-step/SKILL.md) checks on touched files.
3. **Structure (lite)**: diff imports for boundary violations (`packages/core` must not import `packages/pi` or the Pi SDK; peers external in dist; no cycles).

**Extended (adaptive, spawn when diff triggers match):**

| Reviewer        | Trigger                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Public API**  | Any change to an `exports` map entry, a shipped `.d.mts`, or the root `README.md` public surface |
| **Tests**       | New public behavior without a co-located `*.test.ts` covering it                                 |
| **Performance** | Hot paths in the diff (`turn_end` ingest, `context` projection, compaction, FTS queries)         |

## Loop

```text
resolve intent anchor; stamp HEAD
pass = 1
loop:
  Task-batch all applicable reviewers (parallel, readonly)
  parent: merge + dedupe JSON findings
  parent: vet findings (§ Vet step)
  if none actionable → goto done
  fix in-bounds (pass 1: all; passes 2+: blockers first, then in-scope nits)
  per fix: run verification gate from verify-after-each-step on touched files
  if clean and no new findings → goto done
  if pass >= max_passes → goto capped
  pass += 1
  goto loop
capped:
  append deferred rows to LEDGER.md § Deferred
  emit deferred-nits list (each nit must cite plan non-goals or cross-PR blocker, not "optional")
done:
  if uncommitted fixes → git commit -m "harden: …"
  emit final report (include anchor HEAD stamp)
```

## Git

Skill invocation **is** the commit authorization. After the loop: if fixes exist, create one `harden: …` commit immediately. Do not ask first. If the working tree is clean, skip.

## Quick invoke

| Intent           | Say                                                    |
| ---------------- | ------------------------------------------------------ |
| Post-slice       | `/harden-pr lite` or `/harden-pr` after a slice commit |
| Cheap pass       | `/harden-pr quick`                                     |
| Branch done      | `/harden-pr full` or "production-ready pass"           |
| Deferred backlog | `/harden-pr reconcile`                                 |
