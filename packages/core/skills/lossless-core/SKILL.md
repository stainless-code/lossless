---
name: lossless-core
description: Lossless Context Management engine (LcmStore, runCompaction, runRetrieval, runHeal) with ModelHost and Reader ports. Verbatim SQLite store with searchable pointers; the host supplies the model calls.
license: MIT
metadata:
  type: core
  library: "lossless-core"
  library_version: "0.1.1"
sources:
  - stainless-code/lossless:packages/core/src/host.ts
  - stainless-code/lossless:packages/core/src/index.ts
  - stainless-code/lossless:packages/core/README.md
---

# Lossless core

The engine behind `pi-lossless` and `opencode-lossless`: Lossless Context
Management for a long-running agent. Every message is stored verbatim,
aged context is replaced with searchable pointers, and the original text
stays readable by id, entry, or search.

## Minimal wiring

```ts
import { LcmStore, runCompaction, runRetrieval } from "lossless-core";
import type { ModelHost, Reader } from "lossless-core";
```

The engine has no agent SDK dependency. A host supplies two ports and the
engine does the rest. Pi implements both; the OpenCode v2 adapter implements
`ModelHost` and runs retrieval in a host child session instead of `Reader`.

## What it does

- **Ingest.** Every message lands in SQLite with its entry id, role,
  timestamp, and any file handle the host attached.
- **Compaction.** Past a swap ratio, a pass summarizes spans into leaf and
  condensed nodes and leaves a pointer in place. Nothing is deleted.
- **Retrieval.** A reader answers by calling `lcm_grep`, `lcm_describe`,
  and `lcm_expand`, so the answer cites what was read.
- **Repair.** `runHeal` re-derives a truncated summary and its ancestors
  from the provenance rows they still point at.
- **Redaction.** Secret-shaped text is masked on the way to a model, never
  at the door, so an export or read still returns what was stored.

## The two ports

`src/host.ts` documents both. `ModelHost` is what the engine calls a model
through: `session()`, `find()`, `complete()`, plus where notices go.
`Reader` is one retrieval conversation: `begin()` returns a `Reading`
whose `next()` appends results and returns the model reply.

| Type        | Question it answers                                   |
| ----------- | ----------------------------------------------------- |
| `ModelHost` | Which model, and what did it answer                   |
| `Reader`    | What did the reader ask for, and what did it conclude |

## Boundary rule

No module under `src/` imports an agent SDK, a bare specifier other than
`node:*` and `typebox`, or a file outside the engine. The boundary test
fails any violation. Import the package root only.

## Common mistakes

- **Importing engine source deep paths** (`lossless-core/dist/...` or
  relative `src/...` files) instead of the package root.
- **Expecting a host SDK in the bundle** - the host always supplies
  `ModelHost` (and `Reader`, unless the host runs retrieval itself).
- **Assuming compaction deletes** - pointers replace text in context,
  the verbatim rows stay queryable.
- **Redacting at write time** - masking happens on the model path only.

## API surface

- `LcmStore`, `runCompaction`, `runRetrieval`, `runHeal`
- `ModelHost`, `Reader`, `Reading` (types, `src/host.ts`)
