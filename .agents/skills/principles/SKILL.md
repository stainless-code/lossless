---
name: principles
description: Engineering principles index (23 named rules from pstack). Use before a multi-step change, when sizing a diff, designing types or state, deciding what counts as proof, or when a review names a principle. Cite a principle only after reading its section in REFERENCE.md.
---

# Principles

Each entry names when it applies and the rule in one line. Full text per principle lives in [`REFERENCE.md`](./REFERENCE.md); read the section before you cite it. In your reply, name each principle that changed a decision and the decision it changed. A citation with no decision behind it is name-dropping.

## Core

- **Laziness Protocol** ([ref](./REFERENCE.md#laziness-protocol)). Refactoring, sizing a diff, or tempted to add a layer. Bias to deletion and the smallest change that solves the problem.
- **Foundational Thinking** ([ref](./REFERENCE.md#foundational-thinking)). Before writing logic. Core types and data structures first, scaffold before features.
- **Redesign from First Principles** ([ref](./REFERENCE.md#redesign-from-first-principles)). Integrating a new requirement. Redesign as if it had been there from day one instead of bolting it on.
- **Attack the Premise** ([ref](./REFERENCE.md#attack-the-premise)). Two or more fixes sharing one premise failed the same gate. Write the premise down and question it.
- **Subtract Before You Add** ([ref](./REFERENCE.md#subtract-before-you-add)). Sequencing an addition or rewrite. Remove dead weight first, then build on the simpler base.
- **Minimize Reader Load** ([ref](./REFERENCE.md#minimize-reader-load)). Code that is hard to trace. Count layers and hidden state, collapse one-caller wrappers.
- **Outcome-Oriented Execution** ([ref](./REFERENCE.md#outcome-oriented-execution)). Planned rewrites with phase boundaries. Converge on the target, skip throwaway compatibility states.
- **Experience First** ([ref](./REFERENCE.md#experience-first)). Product or scope tradeoffs. The user is whoever consumes the work, including the next maintainer.
- **Exhaust the Design Space** ([ref](./REFERENCE.md#exhaust-the-design-space)). A decision with no precedent. Compare two or three concrete alternatives before committing.
- **Build the Lever** ([ref](./REFERENCE.md#build-the-lever)). Any non-trivial sweep, analysis, or check. Write the script that does or proves it; the script is what a reviewer reruns.

## Architecture

- **Model the Domain** ([ref](./REFERENCE.md#model-the-domain)). Stateful logic or a shape assumption repeated across files. A structure (state machine, table, discriminated union) instead of scattered conditionals.
- **Boundary Discipline** ([ref](./REFERENCE.md#boundary-discipline)). Validation, error handling, adapters. Guards at the boundary (Pi hooks, config file, SQLite rows), pure functions inside.
- **Type System Discipline** ([ref](./REFERENCE.md#type-system-discipline)). Designing a type or signature. Illegal states unrepresentable, external data parsed at the boundary, no lying casts. Syntax in [`typescript-best-practices`](../typescript-best-practices/SKILL.md).
- **Make Operations Idempotent** ([ref](./REFERENCE.md#make-operations-idempotent)). Anything that runs amid restarts and retries (ingest, compaction, GC). Same end state whether it runs once or twice.
- **Migrate Callers Then Delete Legacy APIs** ([ref](./REFERENCE.md#migrate-callers-then-delete-legacy-apis)). A new internal API while old callers exist. Migrate and delete in one wave.
- **Separate Before Serializing Shared State** ([ref](./REFERENCE.md#separate-before-serializing-shared-state)). Concurrent writers to one file or key. Remove the sharing before adding a lock.

## Verification

- **Prove It Works** ([ref](./REFERENCE.md#prove-it-works)). Before declaring done. Check the real artifact (run it, read the value, inspect the diff), not "it compiles".
- **Fix Root Causes** ([ref](./REFERENCE.md#fix-root-causes)). Debugging. Reproduce first, ask why until the cause, no nil-check guards that silence a crash.
- **Sequence Work into Verifiable Units** ([ref](./REFERENCE.md#sequence-verifiable-units)). Multi-step work and commit order. Each unit ends in a check; the failing test lands before the fix.
- **Test Behavior, Not Implementation** ([ref](./REFERENCE.md#test-behavior-not-implementation)). Writing or keeping a test. Call the code as its users do, assert a literal expected value. A test that passes when every import returns `undefined` gets rewritten or deleted.

## Delegation

- **Guard the Context Window** ([ref](./REFERENCE.md#guard-the-context-window)). Large outputs, long files, fan-out. Bulk goes to subagents, summaries stay in the main thread.
- **Never Block on the Human** ([ref](./REFERENCE.md#never-block-on-the-human)). Tempted to ask "should I?" on reversible work. Do it, show the result. Ask only for irreversible actions or product calls.

## Meta

- **Encode Lessons in Structure** ([ref](./REFERENCE.md#encode-lessons-in-structure)). Writing the same instruction a second time, or appending to [`lessons.md`](../../lessons.md). Prefer a check, script, type, or lint over more text; the strongest mechanism the situation allows.
