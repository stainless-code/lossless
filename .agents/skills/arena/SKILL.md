---
name: arena
description: Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for "arena", "arena this", "throw it in the arena", "try N ways", or when one attempt at a non-trivial artifact (a type model, a module shape, a plan, a doc) would lock in the wrong shape.
---

# Arena

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

The deliverable is one artifact plus a short synthesis note. Candidates are inputs, never outputs.

## Start

Open a todo list with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates receive the same prompt, so the prompt is the contract.

1. State the artifact each candidate produces.
2. Derive the rubric. State what success looks like for this task, then turn it into 3 to 6 concrete gradeable criteria. The rubric is the picker's tool in Phase D. Candidates see only the task.
3. Pick the runners. One per distinct model family the `Task` tool lists in this session (one Claude, one GPT, one Grok, one other); two to four runners. Same model N times when the work is generation-bound rather than judgment-sensitive. If a slug is rejected, use the closest listed equivalent and continue.
4. Assign output paths. Each candidate writes to its own location: a git worktree under `.worktrees/arena-<slug>-<n>` (branch `arena/<slug>-<n>`) when the artifact is code, otherwise `/tmp/arena-<slug>/candidate-<n>/`. Per the separate before serializing shared state principle ([REFERENCE.md](../principles/REFERENCE.md)).

## Phase B: Fan out

Spawn all N subagents in one message with `run_in_background: true`, each with the task, the path to the shared grounding, its own output path, and instructions to produce both the artifact and a short rationale naming the alternatives it considered and rejected.

If a candidate produces nothing, proceed with N-1 and note the dropout in the synthesis note.

## Phase C: Cross-judge

After every candidate has completed, spawn one readonly judge subagent on a model family different from the parent's. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the parent's own reading in Phase D, never while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare with the cross-judge. Agreement confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous; read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller API when two feel tied (laziness protocol, [REFERENCE.md](../principles/REFERENCE.md)).

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand (redesign from first principles, [REFERENCE.md](../principles/REFERENCE.md)). Don't paste mechanically. The result has to remain coherent under one mental model.

When N candidates converge on the same shape, that is a strong agreement signal: note it and ship the consensus shape, no graft needed. When N candidates wildly diverge, Phase A was under-specified: reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact holds up under the same gates as any other output (`vp check`, `bun run test`, `bun run typecheck`; prove it works, [REFERENCE.md](../principles/REFERENCE.md)).

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (back to Phase E). Don't paper over.

## Cleanup

Remove every candidate worktree and branch (`git worktree remove`, `git branch -D arena/...`) once the base is committed on `main`. Candidate code never lands as its own commit; only the synthesized artifact does.

## Outputs

One synthesized artifact on `main`. One synthesis note, in the plan file the arena served (or the commit message when there is no plan), naming the base, the grafts with their source candidate, the rejections, the dropouts if any, and the verification result. No candidate names or model names leak into shipped prose.
