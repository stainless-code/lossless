# Grill-with-docs: artifacts and session rules

Companion to the user-invoked [`grill-with-docs`](./SKILL.md) wrapper. Run [`grilling`](../grilling/SKILL.md) first; follow [`docs-governance`](../docs-governance/SKILL.md) for doc lanes.

## Doc-governance shape this skill writes into

This repo is **Tier B only**: one repo-wide `docs/` tree, no per-feature subtrees. Mapping from a generic `CONTEXT.md` + `docs/adr/` template to ours:

| Generic template concept              | This repo's equivalent                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONTEXT.md` (canonical vocabulary)   | `.agents/lessons.md` + the relevant doc lane (this repo has no separate glossary)                                                                |
| Decision records                      | No ADRs. Current decisions: docs/roadmap.md (candidates + rejected); shipped rationale: CHANGELOG.md; durable corrections: `.agents/lessons.md`. |
| `CONTEXT-MAP.md` (multi-context repo) | n/a, single repo-wide context; cross-cutting linkage lives in `docs/architecture.md`                                                             |

This repo has no `docs/` tree; if a term crystallises, propose it in `.agents/lessons.md` or the relevant doc lane (per [`domain-modeling`](../domain-modeling/SKILL.md)).

## Process

### 1. Pre-flight: load the existing language and decisions

Before asking the first question, read (or `Grep` for):

- **Existing doc lanes** (README / ROADMAP / CHANGELOG / COMPARISON, per `docs-governance`). What does the project already call the things in this conversation?
- **docs/roadmap.md (rejected section).** Has a similar idea already been considered and declined? What constraints does that impose?
- **`docs/audits/<topic>.md`.** Has the team already considered (and rejected) a similar shape? Don't re-litigate without evidence.
- **docs/roadmap.md (open work).** Is this thread already a candidate? Cite the existing entry.

Skip whichever files don't exist. Don't bootstrap a doc just to read it.

### 2. Run the grilling loop

Follow the [`grilling`](../grilling/SKILL.md) rules (one question at a time, recommend, explore, push back, dependency-walk). When a term or boundary crystallises, invoke [`domain-modeling`](../domain-modeling/SKILL.md) inline, and record the canonical term in the relevant doc lane.

On top, fire the domain-modeling triggers as terms surface: challenge against `docs/glossary.md`, sharpen fuzzy language, stress-test with concrete scenarios, cross-reference with code. The full trigger set + worked examples live in [`domain-modeling`](../domain-modeling/SKILL.md) § During the session; invoke it inline when a term crystallises and record the canonical term in the relevant doc lane.

### 3. Write decisions back into the docs inline

Don't batch up doc edits for the end. Capture them as they happen:

| Decision shape                                                                              | Where it lands                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A new term is resolved** (or an existing one sharpened)                                   | Record the canonical term in the relevant doc lane on the same PR.                                                                                                                                                                                                 |
| **A current architectural decision is locked in**                                           | Capture in `docs/roadmap.md` (candidate section) while in-flight; lift the rationale into the relevant doc when it ships.                                                                                                                                          |
| **A historical decision needs to be recorded** (rejected alternative, surprising trade-off) | Two paths: (1) part of an in-flight plan → record it in the plan's § Open questions; the lift moment carries it to `architecture.md` or `audits/`. (2) Standalone → append to `docs/audits/<YYYY-MM-DD>-<topic>.md` (create the dated file if substantial enough). |
| **A future-work item surfaces**                                                             | One line in docs/roadmap.md under the appropriate section.                                                                                                                                                                                                         |
| **An ambiguity stays unresolved**                                                           | Flag it in `docs/glossary.md`: create a `## Flagged ambiguities` section on first use if missing (don't quietly resolve). Don't bury the ambiguity in the plan body alone, since the glossary is where readers look for term meaning.                              |

### 4. Where decisions go (the no-ADR convention)

This repo deliberately doesn't carry `docs/adr/`: `docs/architecture.md` (current shipping decisions) and `docs/audits/` (closed historical record) cover it. **Skip the ADR offer entirely**. Instead:

- **"Want me to record this so future architecture reviews don't re-suggest it?"** → for in-flight work, add it to the plan's § Open questions (with the chosen branch); for shipped work, add it to `docs/architecture.md` § `<relevant section>` with the rationale; for closed-and-rejected alternatives, the entry goes in `docs/audits/<topic>.md`.
- **Hard-to-reverse architectural shape** (e.g. "a new subpath entry owns its optional peer; no root barrel") → Plan § Open questions + `architecture.md` § Two seams at lift time.
- **Surprising deviations** (e.g. "`gcTime` is opt-in, not default-on, since dismissed layers shouldn't silently linger forever") → If this is the _durable rationale_, it belongs in `architecture.md` and is cited from JSDoc in source. Don't duplicate.

If the user explicitly asks "should we file an ADR for this?", the answer is "no. This repo's `architecture.md` + `audits/` are the equivalent. Want me to add the entry there?"

### 5. Stop conditions

Same as [`grilling`](../grilling/SKILL.md): stop when a competent contributor could open the PR from the resulting plan. **Plus**:

- docs/roadmap.md is updated with every new term resolved during the session.
- Open questions in the plan have either an answer or an explicit "deferred, needs `<X>`" with a named blocker.
- The plan file's § Open questions (and lift targets) cite the relevant `architecture.md` / `audits/<topic>.md` sections that informed the decisions.

## Checklist (run before declaring done)

- [ ] Read `docs/glossary.md`, `docs/architecture.md`, `docs/audits/` before the first question (or noted "n/a, none exist yet" and created the missing reference doc as part of the session)
- [ ] Every new domain term resolved during the session is in `docs/glossary.md` on the same PR
- [ ] Every locked-in design decision is captured in the plan file (or `architecture.md` if standalone)
- [ ] Every rejected alternative the future explorer needs is captured (plan § Open questions or `audits/`, never lost)
- [ ] Every future-work item surfaced is one line in `roadmap.md`
- [ ] No ADR file was created (we don't use that pattern, see § 4)
- [ ] No `glossary.md` term was quietly re-defined; ambiguities went into `## Flagged ambiguities` (create the section on first use)

## Reference

- [`minimum-diff`](../minimum-diff/SKILL.md) · [`harden-pr`](../harden-pr/SKILL.md) · [`writing-for-agents`](../writing-for-agents/SKILL.md)
