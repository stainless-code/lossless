import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { fmtBytes, fmtTokens } from "lossless-core";

import { cycle, type LcmConfig } from "./config-io.ts";

export interface CockpitDeps {
  getConfig(): LcmConfig;
  patchConfig(patch: Partial<LcmConfig>): void;
  getStats(): { messages: number; summaries: number; dbBytes: number } | undefined;
  getContextUsage(): { tokens: number; contextWindow: number } | undefined;
  getSessionLabel(): string;
  getModels(): string[];
  getActiveZone?(): string | undefined;
  onBackup(): Promise<void> | void;
  onClearCache(): void;
  onDoctor(): void;
  onResetDefaults(): void;
}

const SOFT_RATIOS: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9];
const COMMIT_RATIOS: readonly number[] = [0.75, 0.8, 0.85, 0.9, 0.95];
const SOFT_TOKENS: readonly number[] = [0, 50_000, 80_000, 100_000, 110_000, 120_000, 150_000];
const COMMIT_TOKENS: readonly number[] = [0, 120_000, 130_000, 150_000, 200_000, 300_000];
const SMART_ZONES: readonly number[] = [0, 120_000, 130_000, 150_000, 200_000, 300_000, 500_000];
const KEEP_RECENT: readonly number[] = [10_000, 20_000, 32_000, 48_000, 64_000];
const TARGET_TOKENS: readonly number[] = [750, 1500, 3000, 4500];
const LEAF_CHUNK: readonly number[] = [2000, 3000, 5000, 8000];
const MAX_ASYNC_CHUNKS: readonly number[] = [6, 12, 24, 48];
const LARGE_FILE_CHARS: readonly number[] = [8000, 16_000, 32_000, 64_000, 128_000];

interface RowBase {
  id: string;
  label: string;
  render(): string;
}

type ToggleRow = RowBase & {
  kind: "toggle";
  step(): Partial<LcmConfig>;
};

type CycleRow = RowBase & {
  kind: "cycle";
  step(dir: 1 | -1): Partial<LcmConfig>;
};

type Row = ToggleRow | CycleRow;

function toggleRow(row: {
  id: string;
  label: string;
  get: () => boolean;
  apply: (v: boolean) => Partial<LcmConfig>;
}): ToggleRow {
  return {
    kind: "toggle",
    id: row.id,
    label: row.label,
    render: () => (row.get() ? "on" : "off"),
    step: () => row.apply(!row.get()),
  };
}

function cycleRow<T extends string | number>(row: {
  id: string;
  label: string;
  values: readonly T[];
  get: () => T;
  display?: (v: T) => string;
  apply: (v: T) => Partial<LcmConfig>;
}): CycleRow {
  return {
    kind: "cycle",
    id: row.id,
    label: row.label,
    render: () => {
      const value = row.get();
      return row.display ? row.display(value) : String(value);
    },
    step: (dir) => row.apply(cycle(row.values, row.get(), dir)),
  };
}

export class LcmCockpit {
  public onClose?: () => void;
  private selected = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private busy = false;
  private notice = "";
  private noticeAt = 0;
  private confirmingReset = false;
  private deps: CockpitDeps;
  private theme: Theme;

  constructor(deps: CockpitDeps, theme: Theme) {
    this.deps = deps;
    this.theme = theme;
  }

  private rows(): Row[] {
    const cfg = this.deps.getConfig();
    const models = this.deps.getModels();
    return [
      toggleRow({
        id: "assembly",
        label: "per-turn assembly",
        get: () => cfg.assemblyEnabled !== false,
        apply: (v) => ({ assemblyEnabled: v }),
      }),
      toggleRow({
        id: "redact",
        label: "redact secrets",
        get: () => cfg.redactSecrets !== false,
        apply: (v) => ({ redactSecrets: v }),
      }),
      cycleRow({
        id: "soft",
        label: "swap trigger",
        values: SOFT_RATIOS,
        get: () => cfg.swapAtRatio ?? 0.7,
        display: (v) => `${(v * 100).toFixed(0)}% of window`,
        apply: (v) => ({ swapAtRatio: v }),
      }),
      cycleRow({
        id: "soft-tokens",
        label: "swap trigger (tokens)",
        values: SOFT_TOKENS,
        get: () => cfg.swapAtTokens ?? 0,
        display: (v) => (v === 0 ? "off" : `${fmtTokens(v)} tokens`),
        apply: (v) => ({ swapAtTokens: v === 0 ? undefined : v, smartZone: undefined }),
      }),
      cycleRow({
        id: "smart-zone",
        label: "smart zone (easy)",
        values: SMART_ZONES,
        get: () => cfg.smartZone ?? 0,
        display: (v) =>
          v === 0 ? "off" : `swap ${fmtTokens(v)} · recut ≈ ${fmtTokens(Math.round(v * 1.18))}`,
        apply: (v) => ({
          smartZone: v === 0 ? undefined : v,
          swapAtTokens: undefined,
          recutAtTokens: undefined,
        }),
      }),
      cycleRow({
        id: "commit",
        label: "recut line",
        values: COMMIT_RATIOS,
        get: () => cfg.recutAtRatio ?? 0.85,
        display: (v) => `${(v * 100).toFixed(0)}% of window`,
        apply: (v) => ({ recutAtRatio: v }),
      }),
      cycleRow({
        id: "commit-tokens",
        label: "recut line (tokens)",
        values: COMMIT_TOKENS,
        get: () => cfg.recutAtTokens ?? 0,
        display: (v) => (v === 0 ? "off" : `${fmtTokens(v)} tokens`),
        apply: (v) => ({ recutAtTokens: v === 0 ? undefined : v, smartZone: undefined }),
      }),
      cycleRow({
        id: "keep",
        label: "keep recent",
        values: KEEP_RECENT,
        get: () => cfg.keepRecentTokens ?? 20_000,
        display: (v) => `${fmtTokens(v)} tokens`,
        apply: (v) => ({ keepRecentTokens: v }),
      }),
      cycleRow({
        id: "target",
        label: "summary target",
        values: TARGET_TOKENS,
        get: () => cfg.summaryTokens ?? 1500,
        display: (v) => `${fmtTokens(v)} tokens`,
        apply: (v) => ({ summaryTokens: v }),
      }),
      cycleRow({
        id: "leaf",
        label: "leaf chunk",
        values: LEAF_CHUNK,
        get: () => cfg.leafChunkTokens ?? 3000,
        display: (v) => `${fmtTokens(v)} tokens`,
        apply: (v) => ({ leafChunkTokens: v }),
      }),
      cycleRow({
        id: "chunks",
        label: "max async chunks",
        values: MAX_ASYNC_CHUNKS,
        get: () => cfg.maxAsyncChunks ?? 24,
        display: (v) => `${v} LLM calls`,
        apply: (v) => ({ maxAsyncChunks: v }),
      }),
      cycleRow({
        id: "summarizer",
        label: "summarizer model",
        values: models,
        get: () => primaryEntry(cfg.summarizer) ?? "(session model)",
        display: (v) => chainLabel(cfg.summarizer, v),
        apply: (v) => ({ summarizer: replacePrimary(cfg.summarizer, v) }),
      }),
      toggleRow({
        id: "files",
        label: "externalize large files",
        get: () => cfg.externalizeFiles !== false,
        apply: (v) => ({ externalizeFiles: v }),
      }),
      cycleRow({
        id: "file-size",
        label: "file threshold",
        values: LARGE_FILE_CHARS,
        get: () => cfg.largeFileChars ?? 32_000,
        display: (v) => `${fmtTokens(v)} chars`,
        apply: (v) => ({ largeFileChars: v }),
      }),
    ];
  }

  handleInput(data: string): void {
    const rows = this.rows();
    if (matchesKey(data, Key.escape)) {
      if (this.confirmingReset) {
        this.confirmingReset = false;
        this.notice = "reset cancelled";
        this.noticeAt = Date.now();
        this.invalidate();
        return;
      }
      this.onClose?.();
      return;
    }
    if (data === "q") {
      this.onClose?.();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = (this.selected - 1 + rows.length) % rows.length;
    } else if (matchesKey(data, Key.down)) {
      this.selected = (this.selected + 1) % rows.length;
    } else if (matchesKey(data, Key.left) || data === "h") {
      this.step(rows, -1);
    } else if (matchesKey(data, Key.right) || data === "l" || matchesKey(data, Key.enter)) {
      this.step(rows, 1);
    } else if (data === " ") {
      this.toggle(rows);
    } else if (data === "b") {
      if (this.busy) return;
      this.busy = true;
      this.notice = "backing up…";
      this.noticeAt = Date.now();
      Promise.resolve(this.deps.onBackup())
        .then(() => {
          this.notice = "backup written";
          this.noticeAt = Date.now();
        })
        .catch(() => {
          this.notice = "backup failed";
          this.noticeAt = Date.now();
        })
        .finally(() => {
          this.busy = false;
          this.invalidate();
        });
    } else if (data === "c") {
      this.deps.onClearCache();
      this.notice = "projection cache cleared";
      this.noticeAt = Date.now();
    } else if (data === "d") {
      this.deps.onDoctor();
    } else if (data === "r") {
      if (this.confirmingReset) {
        this.confirmingReset = false;
        this.deps.onResetDefaults();
        this.notice = "all settings reset to defaults";
      } else {
        this.confirmingReset = true;
        this.notice = "armed: press r again to reset";
      }
      this.noticeAt = Date.now();
    }
    if (this.confirmingReset && data !== "r" && data !== "\x1b") {
      this.confirmingReset = false;
    }
    this.invalidate();
  }

  private step(rows: Row[], dir: 1 | -1): void {
    const row = rows[this.selected];
    if (!row || row.kind !== "cycle") return;
    this.deps.patchConfig(row.step(dir));
  }

  private toggle(rows: Row[]): void {
    const row = rows[this.selected];
    if (!row || row.kind !== "toggle") return;
    this.deps.patchConfig(row.step());
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const rows = this.rows();
    const lines: string[] = [];
    const rule = (label: string) => {
      const head = `─ ${label} `;
      const fill = Math.max(0, width - head.length);
      return t.fg("dim", head + "─".repeat(fill));
    };

    const stats = this.deps.getStats();
    const label = this.deps.getSessionLabel();
    lines.push(t.bold("pi-lossless cockpit") + t.fg("dim", `  ${label}`));
    if (stats) {
      lines.push(
        `${t.fg("muted", "store")} ${stats.messages} msgs · ${stats.summaries} summaries · ${fmtBytes(stats.dbBytes)}B`,
      );
    }
    const usage = this.deps.getContextUsage();
    if (usage && usage.contextWindow > 0 && usage.tokens != null) {
      lines.push(`${t.fg("muted", "context")} ${this.gauge(usage, width)}`);
    }
    const zone = this.deps.getActiveZone?.();
    if (zone) {
      lines.push(
        t.fg(
          "warning",
          `⚠ thresholds overridden by zones["${zone}"], so edits below write global config`,
        ),
      );
    }

    lines.push(rule("settings"));
    rows.forEach((row, i) => {
      const sel = i === this.selected;
      const pointer = sel ? t.fg("accent", "❯ ") : "  ";
      const name = sel ? t.bold(row.label) : t.fg("muted", row.label);
      const shown = row.render();
      const value = sel ? t.fg("accent", shown) : shown;
      const hint = sel ? t.fg("dim", row.kind === "toggle" ? "␣ toggle" : "← → cycle") : "";
      lines.push(truncateToWidth(`${pointer}${name}  ${value}  ${hint}`, width));
    });

    lines.push(rule("actions"));
    lines.push(
      t.fg("dim", " b backup   c clear cache   d doctor   r reset defaults   esc close (live)"),
    );
    if (this.confirmingReset) {
      lines.push(
        t.fg("warning", "⚠ press r again to reset all settings to defaults (esc to cancel)"),
      );
    } else if (
      this.notice &&
      Date.now() - this.noticeAt < 4000 &&
      !this.notice.startsWith("press r again")
    ) {
      lines.push(t.fg("success", `✓ ${this.notice}`));
    }
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private gauge(usage: { tokens: number; contextWindow: number }, width: number): string {
    const t = this.theme;
    const cfg = this.deps.getConfig();
    const soft = cfg.swapAtRatio ?? 0.7;
    const frac = Math.min(1, usage.tokens / usage.contextWindow);
    const barW = Math.max(10, Math.min(28, width - 30));
    const filled = Math.round(frac * barW);
    const softTick = Math.round(soft * barW);
    const bar = t.fg("success", "█".repeat(Math.min(filled, softTick)));
    const warnPart = filled > softTick ? t.fg("warning", "█".repeat(filled - softTick)) : "";
    const gap: string[] = [];
    for (let i = 0; i < barW; i++) {
      if (i === softTick) gap.push(t.fg("warning", "│"));
      else if (i >= filled) gap.push(t.fg("dim", "·"));
    }
    const softTok =
      cfg.swapAtTokens != null && cfg.swapAtTokens > 0
        ? cfg.swapAtTokens
        : cfg.smartZone != null && cfg.smartZone > 0
          ? cfg.smartZone
          : null;
    const softLabel = softTok ? `soft ${fmtTokens(softTok)} tok` : `soft ${soft * 100}%`;
    return `${bar}${warnPart}${gap.join("")}  ${(frac * 100).toFixed(0)}% · ${softLabel}`;
  }
}

function primaryEntry(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The row cycles over known models, so it cannot express a chain. Show the
 * whole chain rather than only the entry the row edits.
 */
function chainLabel(value: string | string[] | undefined, shown: string): string {
  return Array.isArray(value) && value.length > 1 ? value.join(" → ") : shown;
}

function replacePrimary(value: string | string[] | undefined, next: string): string | string[] {
  if (!Array.isArray(value)) return next;
  const rest = value.slice(1).filter((entry) => entry !== next);
  return rest.length === 0 ? next : [next, ...rest];
}
