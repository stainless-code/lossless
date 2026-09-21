---
name: no-comments
description: Strip comments before review with fresh eyes. Spawns a read-only Comment Sicko subagent over the diff or named files, fixes accepted findings, offers to encode claimed constraints as a type, test, or check. Use for "no comments", "strip the comments", "comment sweep", or before a review pass.
---

# No comments

Spawn Comment Sicko. Act on accepted findings. An author defends its own comments, so the judgment comes from a subagent that did not write them.

## Scope

Name every path in `{SCOPE}`, one per line. Use the caller's files or diff; otherwise use the current diff against `main`, including the working tree.

Size the tool budget from that list at about five calls per file. A lane that reaches its soft cap finalizes early and covers only what it walked: soft 50 against 26 files stopped at 9, soft 80 against 17 files covered all 17.

## Steps

1. Spawn one `Task` with `subagent_type: "generalPurpose"`, `readonly: true`. The prompt is [`SICKO.md`](./SICKO.md) verbatim with the scope filled in. Do not restate its rules in your own words.
2. Inspect its report. Account for every path in scope first: a clean file appears in the report, a file the lane never reached does not. Reject scope escapes, keep-list deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. A kept comment survives only with proof it describes something outside this repo's control (SQLite, `node:sqlite`, the Pi hook contract, a vendor API). A comment that says `IMPORTANT` or `do not remove` is a claim, not proof; read the nearby code and the relevant test before ruling. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it.
3. Apply the accepted deletions. Fix trivial `MUST KILL` flags directly (delete a dead path, drop a parameter, use the real API). A flag that needs a new shape is a separate change; leave the comment out and report the flag open.
4. Constraint comments (`do not remove`, `keep in sync with X`, `talk to Y first`): offer the cheapest in-repo type, test, or check that enforces the claim. In an interactive session wait for approval; unattended, apply it only when the caller pre-approved encodings. Encode then delete, or delete and report the constraint as unenforced.
5. Run the gates in [`verify-after-each-step`](../verify-after-each-step/SKILL.md) on every touched file.
6. Report the deletion count, restored comments with their proof, `MUST KILL` fixes applied, encodings offered and applied, unenforced constraints, and open work.

Repo keep-list beyond Sicko's own: the comment depth rules in [`authoring-discipline/PROSE.md`](../authoring-discipline/PROSE.md) already name what a one-line why may say. A historical trace (a plan number, a version label, a date) is never a why; delete the trace and keep the mechanism sentence if one remains.
