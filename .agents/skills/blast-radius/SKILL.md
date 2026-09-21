---
name: blast-radius
description: Find what a change could break beyond the diff and prove the one fact it is safe because of by running real code. Use for "blast radius of X", "what could this break", and before any change that deletes, renames, or replaces an exported function, a store method, a policy dep, or a return shape in store.ts, ingest.ts, compaction-engine.ts, context-policy.ts, or the hook adapter, including planned rewrites you wrote the plan for. A plan is not a substitute for asking what the callers see.
---

# Blast radius

Find what a change breaks somewhere else, before it ships.

Listing the callers is not the job. `Grep` does that in a second. The job is the breakage grep will not show you.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it is true. So do not hand back the writeup. Find the one or two facts the whole thing depends on and prove them by running code.

### How sure are you

For each fact the change's safety depends on, get it as far down this list as is cheap, and say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case can't happen. You walked the failure step by step and it does not reach.
4. You ran it. A script or test that calls the real code and fails loud if you are wrong.
5. You reproduced it in a running Pi session.

Any safety fact you cannot get to step 4, say so. Do not write it up as settled. Step 4 in this repo is usually one Vitest case against the real in-memory store, or a `node -e` script that imports `dist/index.mjs`.

## Steps

1. Read the change. The diff, the symbols it adds, changes, and deletes, and what it now does differently, including the part the diff does not spell out. Read the commits that introduced the code it touches (`git log -p --follow`).
2. Find the one fact it is safe because of. Most changes that look risky are safe because of a single fact, like "this call only drops leaves whose span is fully covered by the new summary". Find that fact. If it holds, most risky cases clear at once. Spend your time here, not on a long list of maybes.
3. Look where grep stops. Read the source of the library you call (`node_modules/@earendil-works/pi-coding-agent`, `node:sqlite` docs) and check the pinned version. Work out when things run: the `context` hook is stateless per call, `turn_end` runs after every turn, `session_before_compact` may never fire. Follow what a symbol search misses: the SQLite schema, the metrics JSONL format, the config file shape, the projection Pi reassembles from session entries.
4. Be honest about each risk. Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed. List the ones you checked and cleared separately. Cite a real `file:line`, a search that finds nothing is still an answer, and never make up a caller or an API.
5. Prove the one fact. Write a test or script that runs the real code, run it, and paste what happened. If you cannot prove it cheaply, mark it unproven.
6. For a wide change, ask a second model the same question via a readonly `Task` subagent and merge the answers. Different models catch different real bugs.

## What to hand back

- **What it does.** What changed, including the part that is not obvious.
- **The one fact it is safe because of.** State it, say which step you got it to, and show the proof. If you could not prove it, write unproven.
- **Risks.** Only the real ones. Each names how it breaks, the `file:line`, how likely and how bad, and how to check.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or repro that catches the real bug, including the script you wrote.

Write it through `unslop` and cite real code.
