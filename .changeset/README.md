# Changesets

Run `bun run changeset` when your change should bump the version, then commit the
generated `.changeset/*.md` file on `main` in the same commit as the change. At
release time: `bun run version` (bumps the version and writes the changelog from
the pending changesets), then `bun run pack`.

Two packages, each published from its own directory, so a changeset names the
package it bumps in the frontmatter (`"pi-lossless": patch`). The engine,
`lossless-core`, takes no changeset until it publishes. The changelog text comes
from `@changesets/cli/changelog`, which writes it locally from the changeset
bodies. This repo has no remote and no pull requests, so the GitHub changelog
generator is never used.
