---
name: harden-pr
description: >-
  Bring a branch to pristine, maximum production readiness without changing PR intent:
  spawn parallel Task subagents (never inline review), fix in-bounds findings, loop autonomously until
  clean or pass cap, then report once. Use after a tracer-bullet commit or slice (lite), when a
  milestone lands on main or a `docs/roadmap.md` open item closes (full, no PR needed), on
  "harden", "harden-pr", "pristine", "review until clean", or "production-ready pass".
  Invoking this skill authorizes one harden commit at cycle end.
---

# Harden PR

Leave the branch **pristine**: every changed path shippable, verified, documented, hygienic. Polish what the PR already does; never change its intent or runtime behavior.

**Workflow** (run-to-completion, modes, roster, verification, git): [WORKFLOW.md](./WORKFLOW.md). **Ledger:** `LEDGER.md` beside this skill holds by-design rejections and deferred rows. It is a local working file, so a fresh clone does not carry it and its reads become no-ops there.
