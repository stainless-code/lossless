# Lossless

Lossless Context Management for coding agents: every message is stored verbatim,
aged context is replaced by summaries a model can navigate, and the original text
stays searchable. Nothing is lost, and the model sees less.

This repository holds the engine and the adapters that consume it:

| Package                                            | Directory           | What it is                                                                                                   |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`pi-lossless`](packages/pi/README.md)             | `packages/pi`       | The Pi extension (`pi install npm:pi-lossless`): recall tools, cockpit, commands.                            |
| [`opencode-lossless`](packages/opencode/README.md) | `packages/opencode` | The OpenCode v2 plugin: recall tools, lifecycle commands, DAG projection, per-session sidecar.               |
| [`lossless-core`](packages/core/README.md)         | `packages/core`     | The engine: ingest, compaction, and retrieval behind a two-port host contract, with no agent SDK dependency. |

`lossless-core` is a workspace `devDependency` of the Pi and OpenCode
adapters, and the pack inlines it into `dist/index.mjs`, so each published
package is one self-contained artifact with no runtime dependencies. The Pi
adapter implements both host ports. The OpenCode adapter implements `ModelHost`
and runs retrieval in a host child session, because its plugin API has no
in-process tool-calling completion.

## Where to work

| Path                             | Holds                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/core/src/**`           | the engine; the port in `src/host.ts` is its only host-facing surface                                    |
| `packages/core/test/**`          | engine tests, over port doubles rather than the Pi adapter                                               |
| `packages/pi/src/**`             | the Pi adapter, the only Pi-aware code in the tree                                                       |
| `packages/pi/test/**`            | adapter tests, the Pi-shaped doubles, and the end-to-end spawn                                           |
| `packages/opencode/src/**`       | the OpenCode v2 adapter, the only OpenCode-aware code in the tree                                        |
| `packages/opencode/test/**`      | adapter tests, the host-shaped doubles, and the host-compat guard                                        |
| `apps/docs/**`                   | the documentation site (Blume), its generated pages, and the per-harness page source                     |
| `apps/docs/content/_snippets/**` | shared guide and reference fragments; the per-harness wrappers include them                              |
| `scripts/**`                     | repo tools: the long-context evaluation, the metrics report, the peer census, and the OpenCode live loop |
| `.agents/**`                     | agent rules, skills and lessons                                                                          |

Test support files under `packages/core/test/` are shared on purpose: one HOME
guard, one pass-outcome reader, one temp-home helper, referenced by every
package's test config.

Every package declares its own needs. A library the package calls at runtime is
a `dependencies` entry; a host package the bundle imports rather than inlines is
a `peerDependencies` entry, and also a `devDependencies` entry so the directory
builds and tests on its own; a workspace package it inlines is a
`devDependencies` entry alone. The root `devDependencies` carry the toolchain its
own scripts run.

## Gates

Run these from the root. A red gate stops the next step.

```bash
bun install
bun run test        # all suites (vp test)
bun run typecheck   # one program over the tree
vp check            # format and lint
bun run pack        # all publish bundles, dist included
bun run eval        # the procedural long-context ladder, on demand
```

`bun run pack` writes the `dist/` a live Pi session loads, so after a change
under `packages/*/src` run it and restart Pi. A running OpenCode server reloads
the plugin when its configured directory changes; its loop is
`bun run opencode:check`, `bun run opencode:smoke`, and `bun run opencode:compact`
(see [packages/opencode/README.md](packages/opencode/README.md#live-loop)).
The docs site has its own gates:

```bash
cd apps/docs && bun run build && bun run validate --strict && bun run audit
```

## Docs

|                                                                                                                                                       |                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [The docs site](https://stainless-code.com/lossless/)                                                                                                 | How LCM behaves in a session, the config keys, the limits        |
| [pi-lossless](packages/pi/README.md)                                                                                                                  | Install, the commands, and the three recall tools                |
| [opencode-lossless](packages/opencode/README.md)                                                                                                      | Install, the commands, the four recall tools, and the live loop  |
| [lossless-core](packages/core/README.md)                                                                                                              | The engine's API and the ports a host supplies                   |
| [pi/comparison.mdx](apps/docs/content/reference/pi/comparison.mdx)                                                                                    | Audited Pi peer comparison, page and source in one file          |
| [opencode/comparison.mdx](apps/docs/content/reference/opencode/comparison.mdx)                                                                        | Audited OpenCode v2 peer comparison, page and source in one file |
| [docs/roadmap.md](docs/roadmap.md)                                                                                                                    | Forward-looking work, evidence gates, and rejected items         |
| [pi CHANGELOG.md](packages/pi/CHANGELOG.md), [core CHANGELOG.md](packages/core/CHANGELOG.md), [opencode CHANGELOG.md](packages/opencode/CHANGELOG.md) | Per-package version history, generated from changesets           |
| [AGENTS.md](AGENTS.md)                                                                                                                                | Agent rules, with the skills and lessons under `.agents/`        |

## License

MIT, see [LICENSE](LICENSE).
