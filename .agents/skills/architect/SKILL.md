---
name: architect
description: Sketch types, signatures, and module structure before code, then implement against the chosen sketch. Use for "architect", "architect this", "design this", "what shape should this take", a request marked "write a plan before starting", or any change to a core type model (discriminated unions, store schema, policy result shapes) where jumping to code would lock in the wrong shape.
---

# Architect

Design before implementing. Sketch types, function signatures, and module boundaries with `not implemented` bodies and pseudocode. Get at least two structurally distinct sketches, synthesize one, then fill in code against it. If implementation proves the sketch wrong, throw it out and redesign.

## Start

Open a todo list with one entry per phase.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Phase A: Ground the problem

Build a traced model of every system the new code touches: the callers, the types that cross the boundary, the invariants held in prose today. Use `codedb_context` / `codedb_explain` for the neighbourhood and read the code paths yourself. For rationale, read the plan that motivates the change, [`docs/roadmap.md`](../../../docs/roadmap.md), [`lessons.md`](../../lessons.md), and `git log -p` on the files involved: an existing shape usually encodes a correction someone already paid for.

Naming a file is not grounding. The output of Phase A is a written list of constraints the design must honor (types to interoperate with, callers that cannot break, invariants that crossed our boundary). It goes into the "Problem" section of the rationale.

Skip Phase A only for genuinely greenfield work.

## Phase B: Sketch

Run [`arena`](../arena/SKILL.md) with the design-sketch task and the Phase A constraints. Pass [`RUNNER-PROMPT.md`](RUNNER-PROMPT.md) to every runner. Each candidate produces a design package shaped per [`RATIONALE-TEMPLATE.md`](RATIONALE-TEMPLATE.md): caller's usage first, types derived from it, module map, rationale.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient (exhaust the design space, [REFERENCE.md](../principles/REFERENCE.md)). Whole-shape alternatives, not point fixes inside one shape.

Screen every candidate against [`DESIGN-RED-FLAGS.md`](DESIGN-RED-FLAGS.md) before synthesis: shallow modules, information leakage, temporal decomposition, pass-through methods.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller public surface.

Arena returns one synthesized design package; its synthesis decision fills the rationale's "Synthesis decision" section.

## Phase C: Agree (opt-in)

Default: proceed to implementation. Opt in to a checkpoint only when the owner asks ("architect with checkpoint", "show me before implementing"). Then surface the synthesized design and pause.

The sketch may ship as its own commit (scaffold first, foundational thinking, [REFERENCE.md](../principles/REFERENCE.md)); scoped breakage during fill-in is fine on local `main`. For adversarial pressure on the design before implementing, run [`interrogate`](../interrogate/SKILL.md) on the sketch.

Pushback on the shape, in a checkpoint or after the fact, is Phase A evidence: re-ground and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic, [`tdd`](../tdd/SKILL.md) style: the failing test that pins the caller's usage comes first. The sketch is the contract.

Deviations from the sketch are signal, not friction. A function that needs a parameter the sketch did not anticipate means the sketch was wrong, a requirement was missed, or the implementation is overreaching. Say which.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch cannot absorb, throw the sketch out (redesign from first principles, fix root causes; [REFERENCE.md](../principles/REFERENCE.md)).

The signal is a pattern, not single instances:

- The same shape of workaround appearing across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state was not shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape.

A few edge cases do not condemn an architecture. Complexity in the data is not complexity in the design.

When you scrap: re-ground over what has been built, redesign as if the new constraints had been day-one assumptions, subtract before adding (the new sketch is smaller than the old one before it grows), then return to Phase B.

## Outputs

Caller's usage first, type sketch derived from it. One file of new types and signatures for small changes; module map plus type definitions for larger work. The rationale ships alongside per [`RATIONALE-TEMPLATE.md`](RATIONALE-TEMPLATE.md), as a section of the plan file when the work has one, otherwise in the commit message.
