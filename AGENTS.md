# Agent instructions

This file loads every turn. What belongs in it, and which channels load at all, are defined in [`.agents/README.md`](.agents/README.md). Skills under `.agents/skills/` load by description; everything else is reached by link.

This repo is two packages: `packages/core` is the engine (`lossless-core`) and `packages/pi` is the Pi adapter (`pi-lossless`). [docs/roadmap.md](docs/roadmap.md) holds forward-looking decisions, and [`packages/pi/CHANGELOG.md`](packages/pi/CHANGELOG.md) holds the extension's shipped ones.

## Non-negotiables

- After each step (slice, plan item, fix, doc edit), run `vp check`; on `packages/*/src/**` or `packages/*/test/**` changes also `bun run test` and `bun run typecheck`. Never carry a red gate forward. `bun run test` (`vp test`, Vitest through Vite+) is the only test runner here, and the repo keeps no Bun test config: a bare `bun test` is not a supported way to check a change. Details: [`verify-after-each-step`](.agents/skills/verify-after-each-step/SKILL.md).
- After any turn that changed code under `packages/*/src/`, run `bun run pack`; live Pi sessions keep the old `dist/` until restarted.
- No em dashes in any prose this repo ships or replies with. Apply [`unslop`](.agents/skills/unslop/SKILL.md) to every prose surface.
- Prose names the agent **Pi**. Lowercase forms are identifiers: the `pi` command, `pi-lossless`, `pi-*` package names, `~/.pi/` paths, and version labels that sit beside `node`. Verbatim message text, fixture payloads and quoted host output keep the casing they came with.
- New skills go under `.agents/skills/`. Policy that must fire is a skill or a line in this file, never a file reached only by link ([`.agents/README.md`](.agents/README.md)).
- Skills are repo-local. Never reference a user-level or global skill directory, of any harness or app, in any file here; every skill this repo uses lives under `.agents/skills/`.
- Commit on `main`, one commit per stable milestone, with a changeset for user-visible change.
- Upstream opens on a single init commit, so anything whose reasoning must survive lives in a tracked file: `git log` is not where a decision is recorded.
- Before citing a principle, read its section in [`principles/REFERENCE.md`](.agents/skills/principles/REFERENCE.md).

## Where to look

| Topic                                 | Link                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Hub router                            | [`.agents/README.md`](.agents/README.md)                                             |
| Docs governance and comparison claims | [`.agents/skills/docs-governance/SKILL.md`](.agents/skills/docs-governance/SKILL.md) |
| Past corrections                      | [`.agents/lessons.md`](.agents/lessons.md)                                           |

Human Day-1: [README](README.md) · [Roadmap](docs/roadmap.md) · [Changelog](packages/pi/CHANGELOG.md).
