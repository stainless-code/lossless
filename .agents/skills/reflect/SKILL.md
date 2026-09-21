---
name: reflect
description: Mine the current session's transcript for durable learnings with three parallel reviewer subagents (judgment, tooling, divergent), synthesize, and route each accepted learning to a concrete edit on an existing skill, rule, or lessons.md. Use when the user says "reflect", "what did we learn", "lessons from this session", or at the end of a long autonomous run before the final report.
---

# Reflect

Mine the conversation for learnings that survive code drift, then route them into skill, rule, or lesson edits. Skip when the session was trivial, or when the only learning is one an existing skill already states and the parent followed. One-offs are not learnings.

## 1. Locate the active transcript

Use only the transcript path the system prompt names for this workspace. Do not walk other sessions' directories; that crosses workspace boundaries into unrelated private chats.

```bash
ls -t <agent-transcripts>/*.jsonl <agent-transcripts>/*/*.jsonl <agent-transcripts>/*/subagents/*.jsonl 2>/dev/null | head -10
```

Three layouts: flat (`<id>.jsonl`), nested (`<id>/<id>.jsonl`), subagent (`<parent>/subagents/<child>.jsonl`). For each candidate, read the first line and check that `message.content[0].text` contains this conversation's opening user prompt. If a summary in the system prompt names the transcript path, use it directly. If no path resolves (the main thread's transcript is often absent while only subagent transcripts are present), write a digest to `/tmp/reflect-digest.md` and pass that instead. The digest is the reviewers' only evidence, so it has a required shape: the arc as numbered steps; every owner correction verbatim; every decision with what triggered it; every failure with its cause; the skills actually invoked, by path, and the ones visible but not invoked.

## 2. Spawn three reviewers in parallel

One message, three `Task` calls, `subagent_type: generalPurpose`, `readonly: true` (this repo has no MCP evidence sources the reviewers would need write access for), explicit `model` per reviewer, one model family each where the `Task` tool lists them.

| Lens      | Prompt                                           |
| --------- | ------------------------------------------------ |
| Judgment  | [`JUDGMENT-REVIEWER.md`](JUDGMENT-REVIEWER.md)   |
| Tooling   | [`TOOLING-REVIEWER.md`](TOOLING-REVIEWER.md)     |
| Divergent | [`DIVERGENT-REVIEWER.md`](DIVERGENT-REVIEWER.md) |

Pass each template verbatim, substituting the transcript path or digest where marked. Tell each reviewer where this repo's skills live (`.agents/skills/<name>/SKILL.md`), that policy lives in `.agents/README.md` and `AGENTS.md`, and that `.agents/lessons.md` is the home for corrections that are not skill procedure.

## 3. Synthesize

One `Task` call, `readonly: true`, on a model family different from the parent's, using [`SYNTHESIZER.md`](SYNTHESIZER.md) verbatim with each reviewer's full output inlined where marked. It returns Accepted / Rejected / Backlog.

## 4. Structural enforcement check

For any Accepted item a lint rule, script, test, or runtime check would enforce more reliably than prose, move it to Backlog (encode lessons in structure, [REFERENCE.md](../principles/REFERENCE.md)). In this repo that usually means: a Vitest case, a `vp check` rule, a CI step, or a metric the report already reads.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for the owner's approval before editing any skill or rule. Skill changes steer every future session; the owner picks the subset and may redirect routings.

Then, per approved row:

- Correction that is not procedure: one bullet appended to [`lessons.md`](../../lessons.md), in the existing style.
- Trivial skill or rule edit (a bullet, a tightened sentence, a stale fact): edit directly.
- Substantive skill edit (new section, more than about ten lines) or a new skill: follow [`writing-for-agents`](../writing-for-agents/SKILL.md) and register it in [`.agents/README.md`](../../README.md).
- `tune description: <skill>`: rewrite the description so the trigger words the session used appear in it.

Backlog rows go to the open work or deferred list in [`docs/roadmap.md`](../../../docs/roadmap.md) (mechanism to build, what it would have caught), not to a tracker; this repo has none.

Run [`unslop`](../unslop/SKILL.md) over every prose edit. No em dashes.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<path>`, one line each.
- New skills: `<path>`, one line each (rare).
- Backlog added to `docs/roadmap.md`: one line each.
- Dropped: one line per rejected finding with the synthesizer's reason.
