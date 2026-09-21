# lossless-core

The engine behind [pi-lossless](https://npmx.dev/package/pi-lossless): Lossless
Context Management for a long-running agent. It stores every message verbatim,
replaces aged context with searchable pointers, and keeps the original text
readable by id, entry, or search. The algorithm is
[Lossless Context Management](https://papers.voltropy.com/LCM), by Clint Ehrlich
and Theodore Blackman (Voltropy PBC).

It names no agent SDK. A host implements two ports, and the engine does the rest.

```ts
import { LcmStore, runCompaction, runRetrieval } from "lossless-core";
import type { ModelHost, Reader } from "lossless-core";
```

## What it does

- **Ingest.** Every message lands in SQLite with its entry id, role, timestamp,
  and any file handle the host attached.
- **Compaction.** When occupancy crosses a swap ratio, a pass summarizes spans
  into leaf and condensed nodes and leaves a pointer in their place. Nothing is
  deleted: the store still holds the verbatim text.
- **Retrieval.** A reader answers a question by calling `lcm_grep`,
  `lcm_describe`, and `lcm_expand`, so the answer cites what was read.
- **Redaction.** Secret-shaped text is masked on its way to a model and never
  at the door, so an export or a read can still return what was stored.

## The two ports

`ModelHost` is what the engine calls a model through: `session()`, `find()`,
`complete()`, plus where notices go. `Reader` is one retrieval conversation:
`begin()` returns a `Reading` whose `next()` appends results and returns the
model's reply.

| Type        | Question it answers                                   |
| ----------- | ----------------------------------------------------- |
| `ModelHost` | Which model, and what did it answer                   |
| `Reader`    | What did the reader ask for, and what did it conclude |

`src/host.ts` documents both. The engine's boundary test fails any module under
`src/` that names an agent SDK, a bare specifier other than `node:*` and
`typebox`, or a file outside the engine.

## Where the rest lives

- [pi-lossless](https://npmx.dev/package/pi-lossless): the Pi adapter, and
  every user-facing command.
- [The docs site](https://stainless-code.com/lossless/): how LCM behaves in a
  session, the config keys, and the limits.
