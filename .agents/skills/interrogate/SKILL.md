---
name: interrogate
description: Multi-model adversarial review of a diff. Use for "interrogate", "adversarial review", "multi-model review", "tear this apart", "stress test this code", or before shipping a contested design. Several reviewers on different model families get the same rubric; the lead filters into Act on / Consider / Noted / Dismissed. Never auto-applies changes.
---

# Interrogate

Spawn one reviewer per distinct model family to adversarially review code changes. Each model gets the same prompt and rubric. The adversarial signal comes from model diversity, not assigned personas.

The deliverable is a synthesized verdict. Do not auto-apply changes. For a fix-until-clean loop use [`harden-pr`](../harden-pr/SKILL.md); it may call this skill for its review batch.

## Step 1. Determine scope

- If the user points at specific files or a diff, use that.
- On a branch, `git diff main...HEAD`. On `main` with a range, `git diff <from>..<to>`.
- If the user's message references recent work, gather the relevant files.

Package the diff (or file contents) plus the surrounding context files the reviewers need. Reviewers can read the repo themselves; give them paths and the diff command, not pasted bulk.

## Step 2. State the intent

Write one paragraph from the user's message, the commit messages, and the code. When the code implements a published specification (here the LCM paper, <https://papers.voltropy.com/LCM>), name the spec sections the diff touches and pass them to every reviewer as part of the intent; three models agreeing on a diff cannot catch drift from a spec none of them was told about. If unsure, ask before spawning.

## Step 3. Spawn reviewers

One message, all `Task` calls at once. `subagent_type: "generalPurpose"`, `readonly: true`, and an explicit `model` per reviewer. Pick one model per distinct family from the list the `Task` tool accepts in this session (for example one Claude, one GPT, one Grok, one other); two to four reviewers. If a slug is rejected, use the closest listed equivalent and continue. If the session exposes a single model, run two reviewers on it and say so in the verdict.

Build each prompt from [`REVIEWER-PROMPT.md`](./REVIEWER-PROMPT.md), filling in the intent, the diff command and paths, [`RUBRIC.md`](./RUBRIC.md), and [`CODE-QUALITY.md`](./CODE-QUALITY.md). The same filled template goes to every reviewer.

## Step 4. Synthesize

1. Parse all findings.
2. Findings raised by two or more models independently are the highest signal.
3. Lone-model findings are still read, weighted accordingly.
4. Deduplicate: merge different descriptions of one issue and note which models raised it.
5. Note disagreements where one model flags what another clears.

## Step 5. Lead judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read [`LEAD-JUDGMENT.md`](./LEAD-JUDGMENT.md). Bucket every finding:

- **Act on.** Real issues affecting correctness, security, or maintainability given the goals. Would block a PR.
- **Consider.** Legitimate, but the cost of addressing it now is unclear.
- **Noted.** Valid but not actionable now.
- **Dismissed.** Wrong, nitpicky, or missing context. Say why in one line.

Each finding carries the models that raised it, the bucket, and a one-line rationale.

## Output

```
### Intent
> paragraph

### Reviewers
- Reviewer A: <model>, N findings

### Act on
### Consider
### Noted
### Dismissed
### Agreement map
```

The agreement map says where models agreed, where they diverged, and what the pattern tells you.
