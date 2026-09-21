# `.agents/`, skills & lessons

Source of truth for AI agent configuration in this repo. Pi loads
`.agents/skills/` descriptions and the root `AGENTS.md` (non-negotiables plus
links) every session. The files follow the Agent Skills standard, so a harness
that reads `.agents/skills/` picks up the same descriptions without a second
copy. Skills are repo-local: this repo uses no user-level or
global skill directory from any harness or app, and nothing here points at one.

## What each host loads

This decides where things go, so it is worth getting right:

- **`AGENTS.md` at the repo root: always, every turn.** It holds the
  non-negotiables and a link table, and no procedure. It is the only always-on
  channel.
- **`.agents/skills/<name>/SKILL.md`: loaded by `description`.** The host reads
  every skill's `description` at startup and opens the body when one matches. A
  description is the only automatic trigger. The one other field that changes
  loading is `disable-model-invocation: true`, which hides a skill from the
  model so that only `/skill:<name>` reaches it.
- **Nothing else loads.** `.agents/README.md` and `.agents/lessons.md` are
  reached by link. Frontmatter such as `alwaysApply` or `globs` does nothing at
  any of these paths, so policy that must fire is a skill or an `AGENTS.md`
  line, never a file reached only by link.

## Choosing the home

- Fits in one line and must fire every turn: a bullet in `AGENTS.md`, with a
  link to the detail.
- A procedure with ordered steps, or reference an agent should reach on its
  own: a skill whose `description` names its trigger branches
  ([`writing-for-agents`](skills/writing-for-agents/SKILL.md)).
- A durable correction: one bullet in [`lessons.md`](lessons.md), lifted into a
  skill or an `AGENTS.md` line once it becomes policy.

## Start here

| Question                             | Read                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Repo-root stub (tools / humans)      | [`AGENTS.md`](../AGENTS.md) → this README                                       |
| Verify each step (gates)             | [`skills/verify-after-each-step`](skills/verify-after-each-step/SKILL.md)       |
| Docs governance, comparison claims   | [`skills/docs-governance`](skills/docs-governance/SKILL.md)                     |
| Docs-site voice and build order      | [`skills/docs-voice`](skills/docs-voice/SKILL.md)                               |
| Past corrections                     | [`lessons.md`](lessons.md)                                                      |
| Writing style (every prose surface)  | [`skills/unslop`](skills/unslop/SKILL.md)                                       |
| Engineering principles               | [`skills/principles`](skills/principles/SKILL.md)                               |
| TypeScript rules for any `.ts` edit  | [`skills/typescript-best-practices`](skills/typescript-best-practices/SKILL.md) |
| Docs, JSDoc, PR and commit prose     | [`skills/technical-writing`](skills/technical-writing/SKILL.md)                 |
| Bug with a cheap test path           | [`skills/tdd`](skills/tdd/SKILL.md)                                             |
| What could this diff break           | [`skills/blast-radius`](skills/blast-radius/SKILL.md)                           |
| Comment sweep before review          | [`skills/no-comments`](skills/no-comments/SKILL.md)                             |
| Multi-model adversarial review       | [`skills/interrogate`](skills/interrogate/SKILL.md)                             |
| Fix-until-clean review loop          | [`skills/harden-pr`](skills/harden-pr/SKILL.md)                                 |
| Design a type model before coding    | [`skills/architect`](skills/architect/SKILL.md)                                 |
| N parallel attempts, pick and graft  | [`skills/arena`](skills/arena/SKILL.md)                                         |
| Learnings from a session into skills | [`skills/reflect`](skills/reflect/SKILL.md)                                     |
| What exists on disk right now        | `ls .agents/skills`                                                             |

## Conventions

- **Thin `AGENTS.md`**: one-line non-negotiables plus links, never procedure.
- **No `AGENTS.md` inside skill folders**, use `SKILL.md` plus topic siblings
  (`WORKFLOW.md`, `REFERENCE.md`) for bulk reference.
- **One owner, one link.** Never duplicate a meaning across a skill and this
  file, and never put policy that must fire in a file reachable only by link:
  it is a skill or an `AGENTS.md` line.
- **`lessons.md`**: append-only durable corrections, one bullet each, lifted
  into a skill or an `AGENTS.md` line when a lesson becomes policy.

## Layout

```text
AGENTS.md                  → always loaded: non-negotiables + links here
.agents/
  README.md                → this router
  lessons.md               → durable corrections, one bullet each
  skills/<name>/SKILL.md   → loaded by description from any harness that reads
                             `.agents/skills/`
```
