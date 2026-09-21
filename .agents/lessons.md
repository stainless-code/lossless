---
description: Read lessons when relevant; lift durable ones into a skill or AGENTS.md
---

# Lessons Convention

Scope: facts about this host, this toolchain, and owner policy that no file in
the tree can carry. Nothing here describes the current source tree; a fact the
tree can express belongs in the tree.

## Rules

1. **Read when relevant.** Skim this file when the task touches an area with past
   corrections; not a mandatory full read every session.
2. **Append only durable, non-obvious corrections.** Not session trivia already
   in a rule, skill, or reference doc.
3. **Keep only what the codebase cannot answer.** A lesson belongs here only
   when no type, test, check, config, or comment in the tree answers it. When
   one answers it, retire the bullet and let that artifact carry the rule.
   Policy that must fire is a skill or an `AGENTS.md` line, never a file reached
   only by link.
4. **Keep entries atomic.** One lesson per bullet, one sentence.
5. **Supersede, don't accumulate.** An outdated lesson becomes one replacement
   bullet.

<!-- Append durable corrections below, one bullet per line. -->

- A `.gitignore` entry added in the same commit as `git add -A` does not exclude matching files: the ignore lands after staging, so put the ignore in an earlier commit or run `git rm --cached` afterwards.
- `vp update --latest` removes the `vite-plus` devDep, because it treats the manager as manager-owned: re-add it after any global vp update.
- Resets DELETE, they do not archive (owner policy): every store is re-derivable from its session JSONL at `session_start`, so a clean-slate reset removes `metrics.jsonl` and the store DBs outright, with no `lcm-archive-*` directory.
- A probe script that writes must run under `node`, resolve the metrics path first, and assert it sits inside the temp dir the probe created: Bun ignores `$HOME` for `os.homedir()`, so a fixture `writeFileSync` pointed at a HOME-resolved path can truncate the live metrics file.
- A scripted prose edit must assert every target string and re-read the file afterwards: the formatter reflows markdown tables between passes, and a script that matches nothing still exits 0.
- A notification surface cannot be checked in `pi -p`, where `ctx.ui.notify` reaches nothing: `pi --mode rpc` forwards each notify as an `extension_ui_request` on stdout, which is a live check of a notification-only feature without a TUI.
- A `bun run test` that never finishes with one worker at high CPU is a synchronous infinite loop, not a slow test: vitest's `testTimeout` cannot fire, so bisect by file under an external kill cap and read the verbose reporter's last completed test.
- Compare like populations before quoting a measured number: an audit over every file on disk measures a wider set than the feature reads (the recent stores), so a raw skip count can invert the exposure it claims to report.
