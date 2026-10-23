/** Store lifecycle commands for the OpenCode adapter: backup, export, import,
 * diagnose, migrate, heal, and a manual gc. They all read the same per-session
 * sidecars the recall tools use, so they are registered with or without
 * `assembly`. The cockpit is not here: the promise plugin API has no
 * interactive TUI surface. */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  LcmStore,
  SCHEMA_VERSION,
  buildDiagnoseBundle,
  checkIntegrity,
  depthStats,
  effectiveThresholds,
  exportTranscript,
  importTranscript,
  mergeZone,
  parseExport,
  redactSecrets,
  repairIntegrity,
  storeGeneration,
  type DiagnoseBundleInput,
  type FactConfig,
  type HealOutcome,
  type ThresholdConfig,
} from "lossless-core";

import type { CommandDefinition, ModelRef } from "./host.ts";
import { readMetricRows } from "./metrics.ts";
import type { SidecarRef, Sidecars } from "./sidecars.ts";
import { summarizerConfig, type SummarizerOptions } from "./summarizer.ts";

export interface LifecycleOptions extends SummarizerOptions {
  readonly assembly: boolean;
  readonly swapAtRatio: number;
  readonly recutAtRatio: number;
  readonly keepRecentTokens: number;
  readonly smartZone?: number;
  readonly zones?: Readonly<Record<string, ThresholdConfig>>;
}

export interface HealRunRequest {
  readonly sessionID: string;
  readonly store: LcmStore;
  /** The store's own first and last entry id, which is the span every call in
   * the run summarizes. */
  readonly span: { readonly first: string; readonly last: string };
  readonly dryRun: boolean;
  readonly maxNodes?: number;
}

export interface LifecycleDeps {
  readonly sidecars: Sidecars;
  readonly options: LifecycleOptions;
  readonly version: () => string;
  readonly host: () => string;
  readonly prompt: (sessionID: string, text: string) => Promise<unknown>;
  readonly record: (row: Record<string, unknown>) => void;
  /** Run the bounded repair loop over this session's sidecar. A dry run reads
   * the plan and must not call a model. */
  readonly heal: (request: HealRunRequest) => Promise<HealOutcome>;
  /** The session's model, when the host can name it. Diagnose uses it to
   * report the window and the effective thresholds; the commands still work
   * without it. */
  readonly model?: (sessionID: string) => Promise<ModelRef | undefined>;
  readonly window?: (model: ModelRef) => Promise<number>;
}

const STAMP = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function argsOf(text: string): string[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]?.startsWith("/lossless-")) tokens.shift();
  return tokens;
}

function valueOf(args: readonly string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  // `--save --repair` is a missing value, not a file named `--repair`.
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function currentStore(deps: LifecycleDeps, sessionID: string): LcmStore | undefined {
  if (!existsSync(deps.sidecars.pathFor(sessionID))) return undefined;
  // The adapter's own map owns the handle, so a command does not leak a
  // store it opened only to read one block.
  return deps.sidecars.for(sessionID);
}

function chmodFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function backupCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-backup",
    description: "Write a timestamped copy of this session's sidecar beside it.",
    execute: async (input) => {
      const store = currentStore(deps, input.sessionID);
      if (store === undefined) {
        await deps.prompt(input.sessionID, "LCM backup: no stored history for this session yet.");
        return;
      }
      try {
        const arg = argsOf(input.prompt.text)[0];
        const target =
          arg === undefined
            ? `${deps.sidecars.pathFor(input.sessionID)}.backup-${STAMP()}`
            : resolve(arg);
        store.backup(target);
        chmodFile(target);
        await deps.prompt(input.sessionID, `LCM backup written: ${target}`);
      } catch (error) {
        await deps.prompt(
          input.sessionID,
          `LCM backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function exportCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-export",
    description: "Write this session's verbatim transcript and summaries as JSONL.",
    execute: async (input) => {
      const store = currentStore(deps, input.sessionID);
      if (store === undefined) {
        await deps.prompt(input.sessionID, "LCM export: no stored history for this session yet.");
        return;
      }
      try {
        const arg = argsOf(input.prompt.text)[0];
        const target =
          arg === undefined
            ? join(deps.sidecars.dir, `lossless-export-${STAMP()}.jsonl`)
            : resolve(arg);
        const out = exportTranscript(store);
        writeFileSync(target, `${out.toJSONL()}\n`, { encoding: "utf8", mode: 0o600 });
        chmodFile(target);
        await deps.prompt(
          input.sessionID,
          `LCM export: ${out.messages.length} messages + ${out.summaries.length} summaries -> ${target} (mode 0600).`,
        );
      } catch (error) {
        await deps.prompt(
          input.sessionID,
          `LCM export failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function importCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-import",
    description: "Restore rows from a JSONL file written by lossless-export.",
    execute: async (input) => {
      const args = argsOf(input.prompt.text);
      const arg = args[0];
      if (arg === undefined) {
        await deps.prompt(
          input.sessionID,
          "LCM import: name a file written by /lossless-export, e.g. `/lossless-import lossless-export.jsonl`.",
        );
        return;
      }
      try {
        const parsed = parseExport(readFileSync(resolve(arg), "utf8"));
        if ("error" in parsed) {
          await deps.prompt(input.sessionID, `LCM import refused: ${parsed.error}.`);
          return;
        }
        const result = importTranscript(deps.sidecars.for(input.sessionID), parsed.rows);
        if (result.refused !== undefined) {
          await deps.prompt(input.sessionID, `LCM import refused: ${result.refused}.`);
          return;
        }
        await deps.prompt(
          input.sessionID,
          `LCM import: ${result.messagesInserted} messages inserted, ${result.messagesSkipped} skipped; ${result.summariesInserted} summaries inserted, ${result.summariesSkipped} skipped.`,
        );
      } catch (error) {
        await deps.prompt(
          input.sessionID,
          `LCM import failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function diagnoseCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-diagnose",
    description: "Build a pasteable, redacted diagnostics block for this session.",
    execute: async (input) => {
      const store = currentStore(deps, input.sessionID);
      if (store === undefined) {
        await deps.prompt(input.sessionID, "LCM diagnose: no stored history for this session yet.");
        return;
      }
      try {
        const args = argsOf(input.prompt.text);
        let repairs: string[] = [];
        if (args.includes("--repair")) {
          try {
            repairs = repairIntegrity(store);
          } catch (error) {
            repairs = [`repair failed: ${error instanceof Error ? error.message : String(error)}`];
          }
        }
        const stats = store.stats();
        const integrity = checkIntegrity(store);
        // The bundle is a diagnostic, not a probe: a host model lookup that
        // fails says less, it does not fail the command.
        let model: ModelRef | undefined;
        try {
          model = await deps.model?.(input.sessionID);
        } catch {}
        const modelKey =
          model === undefined ? "(session model)" : `${model.providerID}/${model.id}`;
        const zone = model === undefined ? undefined : deps.options.zones?.[modelKey];
        let windowTokens: number | undefined;
        if (model !== undefined && deps.window !== undefined) {
          try {
            windowTokens = await deps.window(model);
          } catch {}
        }
        const effective =
          windowTokens === undefined
            ? null
            : effectiveThresholds(mergeZone(deps.options, zone), windowTokens);
        const chain = {
          level: "info" as const,
          state: `summarizer: ${Array.isArray(deps.options.summarizer) ? deps.options.summarizer.join(" -> ") : (deps.options.summarizer ?? "auto")}`,
        };
        const config: FactConfig = {
          assemblyEnabled: deps.options.assembly,
          swapAtRatio: deps.options.swapAtRatio,
          recutAtRatio: deps.options.recutAtRatio,
          ...(deps.options.smartZone === undefined ? {} : { smartZone: deps.options.smartZone }),
        };
        const inputBundle: DiagnoseBundleInput = {
          versions: { plugin: deps.version, host: deps.host },
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            mode: "plugin",
          },
          session: {
            store: basename(deps.sidecars.pathFor(input.sessionID)),
            file: "(opencode v2 session)",
            format: "opencode v2",
          },
          facts: {
            stats,
            integrity: { checks: integrity.checks, findings: integrity.findings, repairs },
            depthRows: depthStats(store.allSummaries()),
            pin: null,
            model: modelKey,
            window:
              windowTokens === undefined || effective === null
                ? null
                : { tokens: windowTokens, effective },
            chain,
            zoneConfigured: zone !== undefined,
            config,
            keepRecentTokens: deps.options.keepRecentTokens,
          },
          config: {
            effective: JSON.stringify({
              assembly: deps.options.assembly,
              swapAtRatio: deps.options.swapAtRatio,
              recutAtRatio: deps.options.recutAtRatio,
              keepRecentTokens: deps.options.keepRecentTokens,
              ...(deps.options.smartZone === undefined
                ? {}
                : { smartZone: deps.options.smartZone }),
              ...summarizerConfig(deps.options),
              ...(deps.options.summarizerTokensPerHeal === undefined
                ? {}
                : { summarizerTokensPerHeal: deps.options.summarizerTokensPerHeal }),
              ...(deps.options.zones === undefined ? {} : { zones: deps.options.zones }),
            }),
            path: "opencode.json plugin options",
          },
          metrics: readMetricRows(deps.sidecars.dir).filter(
            (row): row is Record<string, unknown> =>
              isRecord(row) && row.session === input.sessionID,
          ),
          redact: redactSecrets,
          home: homedir(),
        };
        const bundle = buildDiagnoseBundle(inputBundle);
        if (args.includes("--save") && !valueOf(args, "--save")) {
          await deps.prompt(
            input.sessionID,
            "LCM diagnose --save: name the file to write, e.g. `/lossless-diagnose --save lossless-diagnose.txt`.",
          );
          return;
        }
        const save = valueOf(args, "--save");
        if (save !== undefined) {
          const target = resolve(save);
          writeFileSync(target, `${bundle}\n`, { encoding: "utf8", mode: 0o600 });
          chmodFile(target);
          await deps.prompt(
            input.sessionID,
            `LCM diagnose: wrote ${Buffer.byteLength(bundle, "utf8")} bytes to ${target} (mode 0600).`,
          );
          return;
        }
        await deps.prompt(input.sessionID, bundle);
      } catch (error) {
        await deps.prompt(
          input.sessionID,
          `LCM diagnose failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function migrateCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-migrate",
    description: "Upgrade older-schema sidecars in place; dry-run unless --apply is passed.",
    execute: async (input) => {
      const args = argsOf(input.prompt.text);
      const apply = args.includes("--apply");
      // A store this process holds open is already current: its constructor
      // migrated it. Opening a second writer would only race the live session.
      const live = new Set(deps.sidecars.ids());
      const currentPath = deps.sidecars.pathFor(input.sessionID);
      const refs = [
        ...(existsSync(currentPath)
          ? [{ id: basename(currentPath, ".sqlite"), path: currentPath }]
          : []),
        ...deps.sidecars.list(input.sessionID),
      ].filter((ref) => !live.has(ref.id));
      const stale: Array<{ id: string; path: string; generation: number }> = [];
      let current = live.size;
      let broken = 0;
      for (const ref of refs) {
        const generation = storeGeneration(ref.path);
        if (generation === undefined) broken++;
        else if (generation < SCHEMA_VERSION) stale.push({ ...ref, generation });
        else current++;
      }
      if (stale.length === 0) {
        await deps.prompt(
          input.sessionID,
          `LCM migrate: nothing to do (${current} sidecar(s) at generation ${SCHEMA_VERSION}${broken === 0 ? "" : `, ${broken} unreadable`}).`,
        );
        return;
      }
      const summary = stale
        .map((ref) => `  ${ref.id}: generation ${ref.generation} -> ${SCHEMA_VERSION}`)
        .join("\n");
      if (!apply) {
        await deps.prompt(
          input.sessionID,
          `LCM migrate dry-run: ${stale.length} sidecar(s) older than generation ${SCHEMA_VERSION} (${current} current${broken === 0 ? "" : `, ${broken} unreadable`}):\n${summary}\nRun \`/lossless-migrate --apply\` to upgrade them in place.`,
        );
        return;
      }
      let migrated = 0;
      let failed = 0;
      for (const ref of stale) {
        try {
          const store = new LcmStore(ref.path);
          store.close();
          migrated++;
          deps.record({
            kind: "migrate",
            action: "migrated",
            session: ref.id,
            fromGeneration: ref.generation,
            toGeneration: SCHEMA_VERSION,
          });
        } catch (error) {
          failed++;
          deps.record({
            kind: "migrate",
            action: "failed",
            session: ref.id,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
        }
      }
      await deps.prompt(
        input.sessionID,
        `LCM migrate: upgraded ${migrated} of ${stale.length} sidecar(s) to generation ${SCHEMA_VERSION}${failed === 0 ? "" : `, ${failed} failed`}.`,
      );
    },
  };
}

export function gcCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-gc",
    description:
      "List old sidecars, or with --apply export and delete them. Never touches this session.",
    execute: async (input) => {
      const args = argsOf(input.prompt.text);
      const apply = args.includes("--apply");
      if (args.includes("--session") && valueOf(args, "--session") === undefined) {
        await deps.prompt(input.sessionID, "LCM gc: --session takes a session id.");
        return;
      }
      if (args.includes("--older-than") && valueOf(args, "--older-than") === undefined) {
        await deps.prompt(input.sessionID, "LCM gc: --older-than takes a number of days.");
        return;
      }
      const sessionId = valueOf(args, "--session");
      const live = new Set(deps.sidecars.ids());
      if (sessionId !== undefined && live.has(sessionId)) {
        await deps.prompt(
          input.sessionID,
          `LCM gc: session ${sessionId} is open in this process; gc never deletes an open sidecar.`,
        );
        return;
      }
      const rawDays = valueOf(args, "--older-than") ?? "30";
      const days = Number.parseFloat(rawDays.replace(/d$/u, ""));
      if (!Number.isFinite(days) || days < 0) {
        await deps.prompt(input.sessionID, "LCM gc: --older-than takes a number of days.");
        return;
      }
      const refs = deps.sidecars.list(input.sessionID).filter((ref) => !live.has(ref.id));
      const selected = sessionId === undefined ? refs : refs.filter((ref) => ref.id === sessionId);
      if (sessionId !== undefined && selected.length === 0) {
        await deps.prompt(
          input.sessionID,
          `LCM gc: no sidecar for session ${sessionId} (the current session is never a candidate).`,
        );
        return;
      }
      const cutoff = Date.now() - days * 86_400_000;
      const candidates: Array<{ ref: SidecarRef; stat: Stats; mtimeMs: number }> = [];
      for (const ref of selected) {
        try {
          const stat = statSync(ref.path);
          // A write can land in the WAL while the database file's mtime stays
          // put. The newest of the three files is the sidecar's last activity.
          let mtimeMs = stat.mtimeMs;
          for (const suffix of ["-wal", "-shm"]) {
            try {
              mtimeMs = Math.max(mtimeMs, statSync(`${ref.path}${suffix}`).mtimeMs);
            } catch {}
          }
          if (sessionId !== undefined || mtimeMs <= cutoff) {
            candidates.push({ ref, stat, mtimeMs });
          }
        } catch {
          // A sidecar that vanished between the listing and the stat is not a
          // candidate.
        }
      }
      if (candidates.length === 0) {
        await deps.prompt(
          input.sessionID,
          `LCM gc: nothing eligible (${refs.length} other sidecar(s), none older than ${days} day(s)).`,
        );
        return;
      }
      const lines = candidates.map(({ ref, stat, mtimeMs }) => {
        const ageDays = Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
        return `  ${ref.id}: ${(stat.size / 1024).toFixed(0)} KB, ${ageDays.toFixed(1)} day(s) old`;
      });
      if (!apply) {
        await deps.prompt(
          input.sessionID,
          `LCM gc dry-run: ${candidates.length} sidecar(s) removable:\n${lines.join("\n")}\nRun \`/lossless-gc --apply\` to export then delete them. Backups are never touched.`,
        );
        return;
      }
      const exportTarget = join(deps.sidecars.dir, `lossless-export-gc-${STAMP()}.jsonl`);
      // Create the file before the loop so its mode is 0600 even when every
      // candidate turns out to hold no rows.
      writeFileSync(exportTarget, "", { encoding: "utf8", mode: 0o600 });
      let removed = 0;
      let exported = 0;
      let failed = 0;
      for (const { ref, stat } of candidates) {
        try {
          const store = new LcmStore(ref.path, { queryOnly: true });
          let rows = "";
          try {
            rows = exportTranscript(store).toJSONL();
          } finally {
            store.close();
          }
          if (rows.length > 0) {
            appendFileSync(exportTarget, `${rows}\n`, { encoding: "utf8", mode: 0o600 });
            exported++;
          }
          deps.sidecars.drop(ref.id);
          removed++;
          deps.record({
            kind: "gc",
            action: "deleted",
            session: ref.id,
            sizeBytes: stat.size,
            exportedTo: exportTarget,
          });
        } catch (error) {
          failed++;
          deps.record({
            kind: "gc",
            action: "failed",
            session: ref.id,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
        }
      }
      if (exported > 0) chmodFile(exportTarget);
      await deps.prompt(
        input.sessionID,
        `LCM gc: removed ${removed} of ${candidates.length} sidecar(s); ${exported} transcript(s) exported to ${exportTarget}${failed === 0 ? "" : `; ${failed} skipped (migrate or inspect first)`}.`,
      );
    },
  };
}

export function healCommand(deps: LifecycleDeps): CommandDefinition {
  return {
    name: "lossless-heal",
    description:
      "Repair mechanically truncated summaries from their stored sources; dry-run unless --apply is passed.",
    execute: async (input) => {
      const args = argsOf(input.prompt.text);
      if (args.includes("--max-nodes") && valueOf(args, "--max-nodes") === undefined) {
        await deps.prompt(input.sessionID, "LCM heal: --max-nodes takes a positive whole number.");
        return;
      }
      const rawMaxNodes = valueOf(args, "--max-nodes");
      const maxNodes = rawMaxNodes === undefined ? undefined : Number(rawMaxNodes);
      if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes <= 0)) {
        await deps.prompt(input.sessionID, "LCM heal: --max-nodes takes a positive whole number.");
        return;
      }
      const store = currentStore(deps, input.sessionID);
      if (store === undefined) {
        await deps.prompt(input.sessionID, "LCM heal: no stored history for this session yet.");
        return;
      }
      const span = store.entrySpan();
      if (span === undefined) {
        await deps.prompt(input.sessionID, "LCM heal: this session has no stored entries yet.");
        return;
      }
      try {
        const outcome = await deps.heal({
          sessionID: input.sessionID,
          store,
          span,
          dryRun: !args.includes("--apply"),
          ...(maxNodes === undefined ? {} : { maxNodes }),
        });
        await deps.prompt(input.sessionID, healReport(outcome));
      } catch (error) {
        await deps.prompt(
          input.sessionID,
          `LCM heal failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/** The compact result a command prompt carries. No summary or message text
 * leaves the store; the counts are the whole answer. */
export function healReport(outcome: HealOutcome): string {
  if (outcome.dryRun) {
    return outcome.counts.candidates === 0
      ? "LCM heal dry-run: no truncated summaries or stale ancestors; nothing to repair."
      : `LCM heal dry-run: ${outcome.counts.candidates} candidate(s), ${outcome.counts.tainted} truncated; run \`/lossless-heal --apply\` to repair.`;
  }
  const stop = outcome.stop === "done" ? "" : ` (stopped: ${outcome.stop})`;
  const changed = outcome.counts.changed === 0 ? "" : `, changed ${outcome.counts.changed}`;
  return `LCM heal: repaired ${outcome.counts.repaired}, failed ${outcome.counts.failed}, blocked ${outcome.counts.blocked}${changed}, remaining ${outcome.counts.notAttempted}; ${outcome.calls} model call(s)${stop}.`;
}
