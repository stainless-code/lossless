import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lcmHomePath } from "lossless-core";
import { LcmStore, SCHEMA_VERSION } from "lossless-core";
import { exportTranscript } from "lossless-core";
import { importTranscript, parseExport } from "lossless-core";
import { buildReport, collectMetricsEvents, depthStats } from "lossless-core";
import { checkIntegrity, repairIntegrity } from "lossless-core";
import { appendMetric } from "lossless-core";
import {
  listDbFootprints,
  retentionCandidates,
  hashSessionPath,
  SCRATCH_MAX_AGE_MS,
} from "lossless-core";
import { effectiveThresholds, mergeZone, type CommitState } from "lossless-core";
import { describeSummarizerChain, resolveModels } from "lossless-core";
import { fmtTokens } from "lossless-core";
import { buildDiagnoseBundle, readSessionFormat } from "lossless-core";
import { makeRedact } from "lossless-core";
import { storeGeneration } from "lossless-core";
import { sessionFactLines } from "lossless-core";

import { piHostLabel, piModelHost, piModelKey, pluginLabel } from "../host.ts";
import { LcmCockpit, type CockpitDeps } from "./cockpit.ts";
import { DEFAULT_CONFIG, type LcmConfig, lcmConfigPath } from "./config-io.ts";

export interface LcmCommandDeps {
  getStore(): LcmStore | undefined;
  openStore(): LcmStore | undefined;
  getConfig: () => LcmConfig;
  patchConfig: (patch: Partial<LcmConfig>) => void;
  resetConfig: () => void;
  clearCommitState: () => void;
  getCommitState: () => CommitState | null;
  getDbPath(sessionFile: string | undefined): string;
  keepRecentTokens(): number;
}

export const LCM_SUBCOMMANDS = [
  "settings",
  "status",
  "backup",
  "export",
  "import",
  "report",
  "doctor",
  "diagnose",
  "gc",
  "migrate",
] as const;

type SaveFlag = { kind: "path"; path: string } | { kind: "absent" } | { kind: "missing-path" };

function parseSaveFlag(flags: readonly string[]): SaveFlag {
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--save") {
      const next = flags[i + 1];
      return next === undefined ? { kind: "missing-path" } : { kind: "path", path: next };
    }
    if (flag?.startsWith("--save=")) {
      const path = flag.slice("--save=".length);
      return path === "" ? { kind: "missing-path" } : { kind: "path", path };
    }
  }
  return { kind: "absent" };
}

export function registerLcmCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  deps: LcmCommandDeps,
): void {
  pi.registerCommand("lcm", {
    description: `LCM ${LCM_SUBCOMMANDS.join(" | ")}`,
    handler: async (args, ctx) => {
      const config = deps.getConfig();
      const sub = (args ?? "").trim().split(/\s+/)[0] ?? "status";
      const db = deps.getDbPath(ctx.sessionManager.getSessionFile() ?? undefined);

      // Import restores history, so it is the one subcommand that opens the store:
      // every other one reads what the session has already ingested.
      if (sub === "import") {
        const store = deps.openStore();
        if (!store) {
          ctx.ui.notify("LCM import: no live session to import into.", "warning");
          return;
        }
        const arg = (args ?? "").trim().split(/\s+/).slice(1)[0];
        if (!arg) {
          ctx.ui.notify("LCM import: name a file written by /lcm export.", "warning");
          return;
        }
        let text: string;
        try {
          text = readFileSync(arg, "utf8");
        } catch (error) {
          ctx.ui.notify(
            `LCM import: cannot read ${arg} (${error instanceof Error ? error.message : String(error)}).`,
            "warning",
          );
          return;
        }
        const parsed = parseExport(text);
        if ("error" in parsed) {
          appendMetric({ event: "lcm", kind: "import", db, refused: parsed.error });
          ctx.ui.notify(`LCM import refused: ${parsed.error}.`, "warning");
          return;
        }
        const result = importTranscript(store, parsed.rows);
        appendMetric({ event: "lcm", kind: "import", db, ...result });
        const counted = (count: number, one: string, many: string) =>
          `${count} ${count === 1 ? one : many}`;
        ctx.ui.notify(
          result.refused
            ? `LCM import refused: ${result.refused}.`
            : `LCM import: ${counted(result.messagesInserted, "message", "messages")} and ${counted(result.summariesInserted, "summary", "summaries")} restored; ${counted(result.messagesSkipped + result.summariesSkipped, "row", "rows")} already present.`,
          result.refused ? "warning" : "info",
        );
        return;
      }

      const store = deps.getStore();
      if (!store) {
        ctx.ui.notify(
          "LCM: no store for this session yet: nothing has been ingested, and an ephemeral session never writes one.",
          "info",
        );
        return;
      }
      const s = store.stats();

      if (sub === "settings" || sub === "cockpit") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("LCM cockpit requires interactive mode (TUI).", "warning");
          return;
        }
        const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
        const activeZone = () => {
          const mk = piModelKey(ctx);
          const z = mk ? deps.getConfig().zones?.[mk] : undefined;
          return z ? mk : undefined;
        };
        const cockpitDeps: CockpitDeps = {
          getConfig: deps.getConfig,
          patchConfig: deps.patchConfig,
          getStats: () => deps.getStore()?.stats(),
          getActiveZone: activeZone,
          getContextUsage: () => {
            const u = ctx.getContextUsage();
            return u ? { tokens: u.tokens ?? 0, contextWindow: u.contextWindow } : undefined;
          },
          getSessionLabel: () => {
            const f = sessionFile ?? "(ephemeral)";
            const parts = f.split("/");
            return parts[parts.length - 1] ?? f;
          },
          getModels: () => {
            const scoped = (ctx.scopedModels ?? []).map((e) => `${e.model.provider}/${e.model.id}`);
            if (scoped.length > 0) return scoped;
            try {
              return ctx.modelRegistry
                .getAvailable()
                .slice(0, 60)
                .map((m: { provider: string; id: string }) => `${m.provider}/${m.id}`);
            } catch {
              return [];
            }
          },
          onBackup: () => {
            const st = deps.getStore();
            if (!st) return;
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            st.backup(`${db}.backup-${stamp}`);
          },
          onClearCache: deps.clearCommitState,
          onResetDefaults: deps.resetConfig,
          onDoctor: () => {
            const st = deps.getStore()?.stats();
            if (!st) return;
            const chain = describeSummarizerChain(
              resolveModels(piModelHost(ctx), deps.getConfig()),
            );
            ctx.ui.notify(
              [
                `LCM doctor: ${st.messages} msgs, ${st.summaries} summaries, ${(st.dbBytes / 1024).toFixed(0)} KB, pinned projection ${deps.getCommitState() ? "yes" : "no"}, assembly ${deps.getConfig().assemblyEnabled === false ? "off" : "on"}`,
                chain.state,
                ...(chain.level === "warning" ? [`⚠ ${chain.warning}`] : []),
              ].join("\n"),
              chain.level,
            );
          },
        };
        await ctx.ui.custom<boolean>(
          (tui, theme, _keybindings, done) => {
            const cockpit = new LcmCockpit(cockpitDeps, theme);
            cockpit.onClose = () => done(true);
            return {
              render: (width: number) => cockpit.render(width),
              handleInput: (data: string) => {
                cockpit.handleInput(data);
                tui.requestRender();
              },
              invalidate: () => cockpit.invalidate(),
            };
          },
          { overlay: true },
        );
        return;
      }

      if (sub === "status") {
        const pin = deps.getCommitState();
        const usage = ctx.getContextUsage();
        const window = usage?.contextWindow ?? 0;
        const tokens = usage?.tokens ?? 0;
        const mk = piModelKey(ctx);
        const stored = deps.getStore()?.getModelState(mk);
        const corrected = stored?.contextWindow ?? null;
        const resolved =
          window > 0
            ? effectiveThresholds(mergeZone(config, config.zones?.[mk]), window)
            : undefined;
        ctx.ui.notify(
          [
            `LCM: ${s.messages}${s.removedMessages > 0 ? ` (${s.removedMessages} removed, retained)` : ""} messages, ${s.summaries} summaries, ${(s.dbBytes / 1024).toFixed(0)} KB`,
            `projection: ${pin ? `pinned at cut ${pin.cutCount} (applied at ${(pin.appliedAtOccupancy * 100).toFixed(0)}%)` : "none"}`,
            `context: ${window > 0 ? `${((tokens / window) * 100).toFixed(0)}% of ${fmtTokens(window)}` : "unknown"}`,
            `thresholds: ${resolved ? `swap ${(resolved.swap * 100).toFixed(0)}% / recut ${(resolved.recut * 100).toFixed(0)}%${resolved.clamped ? " (clamped)" : ""}` : "window unknown"}`,
            `window: ${
              corrected === null
                ? `${window > 0 ? fmtTokens(window) : "unknown"} (Pi's belief, uncorrected)`
                : `Pi believes ${window > 0 ? fmtTokens(window) : "unknown"}, corrected to ${fmtTokens(corrected)} (${stored?.windowSource ?? "stated"})`
            }`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "backup") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const target = `${db}.backup-${stamp}`;
        store.backup(target);
        ctx.ui.notify(`LCM backup written: ${target}`, "info");
        return;
      }

      if (sub === "export") {
        const arg = (args ?? "").trim().split(/\s+/).slice(1)[0];
        const target =
          arg && arg.length > 0
            ? arg
            : `lcm-export-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
        const out = exportTranscript(store);
        writeFileSync(target, `${out.toJSONL()}\n`, "utf8");
        try {
          chmodSync(target, 0o600);
        } catch {}
        ctx.ui.notify(
          `LCM export: ${out.messages.length} messages + ${out.summaries.length} summaries → ${resolve(target)}`,
          "info",
        );
        return;
      }

      if (sub === "gc") {
        const flags = (args ?? "").split(/\s+/).slice(1);
        const apply = flags.includes("--apply");
        const sessionPathHashes = new Set<string>();
        const sessionsRoot = lcmHomePath("sessions");
        const walk = (d: string) => {
          let entries: Array<{ name: string; isDirectory(): boolean }>;
          try {
            entries = readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".jsonl")) sessionPathHashes.add(hashSessionPath(p));
          }
        };
        walk(sessionsRoot);
        const candidates = retentionCandidates({
          dir: lcmHomePath("lcm"),
          liveDbPath: db,
          sessionPathHashes,
          now: Date.now(),
          scratchMaxAgeMs: SCRATCH_MAX_AGE_MS,
        });
        if (candidates.length === 0) {
          ctx.ui.notify("LCM gc: nothing eligible (all session files still exist).", "info");
          return;
        }
        const summary = candidates
          .map(
            (c) =>
              `  ${c.path.split("/").pop()}: ${(c.sizeBytes / 1024).toFixed(0)} KB (${c.reason})`,
          )
          .join("\n");
        if (!apply) {
          ctx.ui.notify(
            `LCM gc dry-run: ${candidates.length} removable DB(s):\n${summary}\nRun \`/lcm gc --apply\` to export-then-delete (backups are never touched).`,
            "info",
          );
          return;
        }
        // Beside the stores it protects, like `/lcm backup`, and never in the
        // directory Pi happened to be started from: this file holds stored bytes,
        // secrets included, and a project directory is where those get committed.
        const exportTarget = join(
          lcmHomePath("lcm"),
          `lcm-export-gc-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
        );
        let removed = 0;
        let exportStarted = false;
        for (const c of candidates) {
          try {
            const candidateStore = new LcmStore(c.path);
            const part = exportTranscript(candidateStore).toJSONL();
            candidateStore.close();
            if (part.length > 0) {
              if (!exportStarted) {
                if (!existsSync(exportTarget)) writeFileSync(exportTarget, "", "utf8");
                exportStarted = true;
              }
              appendFileSync(exportTarget, `${part}\n`, "utf8");
            }
            unlinkSync(c.path);
            try {
              unlinkSync(`${c.path}-wal`);
              unlinkSync(`${c.path}-shm`);
            } catch {}
            removed++;
            appendMetric({
              event: "lcm",
              kind: "gc-deleted",
              db: c.path,
              reason: c.reason,
              sizeBytes: c.sizeBytes,
              exportedTo: exportTarget,
            });
          } catch (error) {
            appendMetric({
              event: "lcm",
              kind: "compaction-error",
              stage: "gc",
              db: c.path,
              error: error instanceof Error ? error.message.slice(0, 300) : String(error),
            });
          }
        }
        if (!exportStarted && !existsSync(exportTarget)) writeFileSync(exportTarget, "", "utf8");
        try {
          chmodSync(exportTarget, 0o600);
        } catch {}
        ctx.ui.notify(
          `LCM gc: removed ${removed} of ${candidates.length} DB(s); transcripts exported to ${exportTarget}.`,
          "info",
        );
        return;
      }

      if (sub === "migrate") {
        const apply = (args ?? "").split(/\s+/).slice(1).includes("--apply");
        const storeDir = lcmHomePath("lcm");
        const stale: Array<{ path: string; name: string; generation: number; sizeBytes: number }> =
          [];
        let current = 0;
        let broken = 0;
        for (const fp of listDbFootprints(storeDir)) {
          if (fp.name.startsWith("scratch-")) continue;
          const generation = storeGeneration(fp.path);
          if (generation === undefined) broken++;
          else if (generation < SCHEMA_VERSION) stale.push({ ...fp, generation });
          else current++;
        }
        if (stale.length === 0) {
          ctx.ui.notify(
            `LCM migrate: nothing to do (${current} store(s) at generation ${SCHEMA_VERSION}${broken === 0 ? "" : `, ${broken} unreadable`}).`,
            "info",
          );
          return;
        }
        const summary = stale
          .map(
            (s) =>
              `  ${s.name}: generation ${s.generation} → ${SCHEMA_VERSION} (${(s.sizeBytes / 1024).toFixed(0)} KB)`,
          )
          .join("\n");
        if (!apply) {
          ctx.ui.notify(
            `LCM migrate dry-run: ${stale.length} store(s) older than generation ${SCHEMA_VERSION} (${current} already current${broken === 0 ? "" : `, ${broken} unreadable`}):\n${summary}\nRun \`/lcm migrate --apply\` to upgrade them in place. A store is a rebuildable index, and the upgrade is the same one its own session applies when it next opens.`,
            "info",
          );
          return;
        }
        let migrated = 0;
        let failed = 0;
        for (const s of stale) {
          try {
            const candidate = new LcmStore(s.path);
            const fromGeneration = candidate.generation;
            candidate.close();
            migrated++;
            appendMetric({
              event: "lcm",
              kind: "store-migrated",
              db: s.name,
              fromGeneration,
              toGeneration: SCHEMA_VERSION,
            });
          } catch (error) {
            failed++;
            appendMetric({
              event: "lcm",
              kind: "compaction-error",
              stage: "migrate",
              db: s.path,
              error: error instanceof Error ? error.message.slice(0, 300) : String(error),
            });
          }
        }
        ctx.ui.notify(
          `LCM migrate: upgraded ${migrated} of ${stale.length} store(s) to generation ${SCHEMA_VERSION}${failed === 0 ? "" : `, ${failed} failed`}. Cross-session search now reads them.`,
          "info",
        );
        return;
      }

      if (sub === "report") {
        const report = buildReport(collectMetricsEvents());
        ctx.ui.notify(report, "info");
        return;
      }

      if (sub === "doctor") {
        const usage = ctx.getContextUsage();
        const window = usage?.contextWindow ?? 0;
        const mk = piModelKey(ctx);
        const z = config.zones?.[mk];
        const pin = deps.getCommitState();
        const flags = (args ?? "").trim().split(/\s+/).slice(1);
        const repairs = flags.includes("--repair") ? repairIntegrity(store) : [];
        const integrity = checkIntegrity(store);
        const violations = integrity.findings.filter((f) => f.severity === "violation");
        const chain = describeSummarizerChain(resolveModels(piModelHost(ctx), config));
        const lines = [
          `LCM doctor: ${db}`,
          ...sessionFactLines({
            stats: s,
            integrity: { checks: integrity.checks, findings: integrity.findings, repairs },
            depthRows: depthStats(store.allSummaries()),
            pin,
            model: mk,
            window:
              window > 0
                ? { tokens: window, effective: effectiveThresholds(mergeZone(config, z), window) }
                : null,
            chain,
            zoneConfigured: z !== undefined,
            config,
            keepRecentTokens: deps.keepRecentTokens(),
            configPath: lcmConfigPath(),
          }),
        ];
        const dir = lcmHomePath("lcm");
        const footprints = listDbFootprints(dir);
        const totalBytes = footprints.reduce((n, f) => n + f.sizeBytes, 0);
        const backupCount = (() => {
          try {
            return readdirSync(dir).filter((f) => f.includes(".backup-")).length;
          } catch {
            return 0;
          }
        })();
        lines.push(
          `store footprint: ${footprints.length} session DBs, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total, ${backupCount} backup file(s) (never auto-deleted)`,
        );
        for (const f of footprints.slice(0, 20)) {
          const tag = f.path === db ? " (this session)" : "";
          const ageMs = Math.max(0, Date.now() - f.modifiedAt);
          const age =
            ageMs < 60_000
              ? "just now"
              : ageMs < 3_600_000
                ? `${Math.round(ageMs / 60_000)}m ago`
                : ageMs < 86_400_000
                  ? `${Math.round(ageMs / 3_600_000)}h ago`
                  : `${Math.round(ageMs / 86_400_000)}d ago`;
          lines.push(`  ${f.name}: ${(f.sizeBytes / 1024).toFixed(0)} KB, modified ${age}${tag}`);
        }
        if (footprints.length > 20) lines.push(`  … ${footprints.length - 20} more`);
        ctx.ui.notify(
          lines.join("\n"),
          chain.level === "warning" || violations.length > 0 ? "warning" : "info",
        );
        return;
      }

      if (sub === "diagnose") {
        // The block is bytes a reporter may have to copy, and a copy of a
        // notification carries the host's line breaks. `--save` is the path
        // that never wraps; both forms write the same block the notify would.
        const save = parseSaveFlag((args ?? "").trim().split(/\s+/).slice(1));
        if (save.kind === "missing-path") {
          ctx.ui.notify(
            "LCM diagnose --save: name the file to write, e.g. `/lcm diagnose --save lcm-diagnose.txt`.",
            "warning",
          );
          return;
        }
        const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
        const usage = ctx.getContextUsage();
        const window = usage?.contextWindow ?? 0;
        const mk = piModelKey(ctx);
        const z = config.zones?.[mk];
        const integrity = checkIntegrity(store);
        const chain = describeSummarizerChain(resolveModels(piModelHost(ctx), config));
        const effective = { ...DEFAULT_CONFIG, ...config };
        const tag = basename(db);
        const bundle = buildDiagnoseBundle({
          versions: { plugin: pluginLabel, host: piHostLabel },
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            mode: ctx.mode,
          },
          session: {
            store: tag,
            file: sessionFile === undefined ? "(none)" : basename(sessionFile),
            format: readSessionFormat(sessionFile),
          },
          facts: {
            stats: s,
            integrity: { checks: integrity.checks, findings: integrity.findings, repairs: [] },
            depthRows: depthStats(store.allSummaries()),
            pin: deps.getCommitState(),
            model: mk,
            window:
              window > 0
                ? { tokens: window, effective: effectiveThresholds(mergeZone(config, z), window) }
                : null,
            chain,
            zoneConfigured: z !== undefined,
            config: effective,
            keepRecentTokens: deps.keepRecentTokens(),
          },
          config: { effective: JSON.stringify(effective), path: lcmConfigPath() },
          metrics: collectMetricsEvents().filter((e) => e.session === tag),
          redact: makeRedact(deps.getConfig),
          home: homedir(),
        });
        const level =
          chain.level === "warning" || integrity.findings.some((f) => f.severity === "violation")
            ? "warning"
            : "info";
        if (save.kind === "path") {
          try {
            writeFileSync(save.path, `${bundle}\n`, "utf8");
            chmodSync(save.path, 0o600);
          } catch (error) {
            ctx.ui.notify(
              `LCM diagnose: cannot write ${save.path} (${error instanceof Error ? error.message : String(error)}).`,
              "warning",
            );
            return;
          }
          ctx.ui.notify(
            `LCM diagnose: wrote ${Buffer.byteLength(bundle, "utf8")} bytes to ${save.path} (mode 0600); the block is in the file, not in this notification.`,
            level,
          );
          return;
        }
        ctx.ui.notify(bundle, level);
        return;
      }

      ctx.ui.notify(
        `LCM: ${s.messages} messages, ${s.summaries} summaries, ${(s.dbBytes / 1024).toFixed(0)} KB in ${db}`,
        "info",
      );
    },
  });
}
