# Lossless

Lossless Context Management for coding agents: every message is stored verbatim,
aged context is replaced by summaries a model can navigate, and the original text
stays searchable. Nothing is lost, and the model sees less.

This repository holds the engine and the Pi extension that consumes it:

| Package                                    | Directory       | What it is                                                                                                    |
| ------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| [`pi-lossless`](packages/pi/README.md)     | `packages/pi`   | The extension a Pi user installs (`pi install npm:pi-lossless`): the recall tools, the cockpit, the commands. |
| [`lossless-core`](packages/core/README.md) | `packages/core` | The engine: ingest, compaction and retrieval behind a two-port host contract, naming no agent SDK.            |

`lossless-core` is a workspace `devDependency` of the adapter, and the pack
inlines it into `dist/index.mjs`, so the installed package stays one
self-contained artifact with no runtime dependencies. A harness other than Pi
implements `ModelHost` and `Reader` and drives the engine from
[`lossless-core`](https://npmx.dev/package/lossless-core).

## Where to work

| Path                    | Holds                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `packages/core/src/**`  | the engine; the port in `src/host.ts` is its only host-facing surface        |
| `packages/core/test/**` | engine tests, over port doubles rather than the Pi adapter                   |
| `packages/pi/src/**`    | the Pi adapter, the only Pi-aware code in the tree                           |
| `packages/pi/test/**`   | adapter tests, the Pi-shaped doubles, and the end-to-end spawn               |
| `apps/docs/**`          | the documentation site (Blume)                                               |
| `scripts/**`            | repo tools: the long-context evaluation, the metrics report, the peer census |
| `.agents/**`            | agent rules, skills and lessons                                              |

Test support files under `packages/core/test/` are shared on purpose: one HOME
guard, one pass-outcome reader, one temp-home helper, referenced by both
packages' test configs.

Every package declares its own needs. A library the package calls at runtime is
a `dependencies` entry; a host package the bundle imports rather than inlines is
a `peerDependencies` entry, and also a `devDependencies` entry so the directory
builds and tests on its own; a workspace package it inlines is a
`devDependencies` entry alone. The root `devDependencies` carry the toolchain its
own scripts run.

## Gates

Run these from the root. Every step is green by itself, and no gate is carried
red into the next one.

```bash
bun install
bun run test        # both suites, the only runner (vp test under the hood)
bun run typecheck   # one program over the tree
vp check            # format and lint
bun run pack        # both publish bundles, dist included
bun run eval        # the procedural long-context ladder, on demand
```

`bun run pack` writes the `dist/` a live Pi session loads, so after a change
under `packages/*/src` run it and restart Pi. The docs site has its own gates:

```bash
cd apps/docs && bun run build && bun run validate --strict && bun run audit
```

## Docs

|                                                       |                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| [The docs site](https://stainless-code.com/lossless/) | How LCM behaves in a session, the config keys, the limits                       |
| [pi-lossless](packages/pi/README.md)                  | Install, the commands, and the three recall tools                               |
| [lossless-core](packages/core/README.md)              | The engine's API and the two ports a host implements                            |
| [COMPARISON.md](apps/docs/COMPARISON.md)              | Peer comparison with verified cells, the source behind the site comparison page |
| [docs/roadmap.md](docs/roadmap.md)                    | Forward-looking work, evidence gates, and rejected items                        |
| [CHANGELOG.md](packages/pi/CHANGELOG.md)              | Version history, generated from changesets                                      |
| [AGENTS.md](AGENTS.md)                                | Agent rules, with the skills and lessons under `.agents/`                       |

## License

MIT, see [LICENSE](LICENSE).
