import { estimateTokens } from "./estimate-tokens.ts";
import { describeFile } from "./files.ts";
import type { IngestStore, LcmRole } from "./store.ts";

export interface IngestibleEntry {
  entryId: string;
  role: LcmRole;
  text: string;
  timestamp: number;
  payload?: string;
  /** The path a tool call named for this body, when one did. The only
   * deterministic signal that a body is a file, so the only externalization
   * trigger. */
  fileHint?: { path: string };
  /** Pi's own head compaction, landing as a `custom` role because every role Pi
   * does not name folds to `custom`: the one observable event that the window
   * filled and LCM did not hold it. */
  piCompaction?: boolean;
}

export interface ExternalizedFile {
  entryId: string;
  fileId: string;
  path: string;
  kind: string;
  bytes: number;
}

export interface IngestStats {
  inserted: number;
  skipped: number;
  /** Entry ids inserted with `piCompaction`, so a re-scan cannot count one twice. */
  piCompactions: string[];
  files: ExternalizedFile[];
  largeInline: Array<{ entryId: string; chars: number }>;
}

export interface IngestWatermark {
  id: string;
}

function indexAfterWatermark(
  length: number,
  idAt: (i: number) => string,
  watermarkId: string,
): number {
  for (let i = length - 1; i >= 0; i--) {
    if (idAt(i) === watermarkId) return i + 1;
  }
  return -1;
}

export interface RawEntryLike {
  id?: string;
}

export function isIngestible(e: { entryId: string; text: string }): boolean {
  return e.entryId.length > 0 && e.text.trim().length > 0;
}

/** The watermark a hook carries after considering `delta`: its last entry,
 * whether or not any of it was stored. A turn that carries nothing addressable
 * still moves the watermark, or the next turn rescans the whole session. */
export function nextIngestWatermark(delta: Array<{ entryId: string }>): IngestWatermark | null {
  const last = delta[delta.length - 1];
  return last ? { id: last.entryId } : null;
}

export interface RawIngestDelta {
  startIndex: number;
  reset: boolean;
}

export function computeRawIngestDelta(
  entries: readonly RawEntryLike[],
  watermark: IngestWatermark | null,
): RawIngestDelta {
  if (!watermark) return { startIndex: 0, reset: true };
  const after = indexAfterWatermark(entries.length, (i) => entries[i]!.id ?? "", watermark.id);
  return after === -1 ? { startIndex: 0, reset: true } : { startIndex: after, reset: false };
}

export function entryToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "toolCall" || b.type === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "?";
      parts.push(`[tool:${name}] ${JSON.stringify(b.arguments ?? b.input ?? {})}`);
    } else if (b.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function dropsContent(block: unknown): boolean {
  if (!block || typeof block !== "object") return true;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text !== "string";
    case "toolCall":
    case "tool_use":
      // entryToText renders whichever argument field exists, never both.
      return b.arguments !== undefined && b.input !== undefined;
    default:
      return true;
  }
}

/** The raw content blocks as JSON when `entryToText(content)` is not a faithful
 * rendering of them, `undefined` when the derived text is the whole message.
 * The whole array is stored, so a payload is never itself a lossy projection;
 * the rule about which messages get one is what keeps a text-only message at a
 * single copy. */
export function payloadOf(content: unknown): string | undefined {
  if (typeof content === "string") return undefined;
  if (!Array.isArray(content)) return content == null ? undefined : JSON.stringify(content);
  if (content.length === 0) return undefined;
  if (!content.some(dropsContent)) return undefined;
  return JSON.stringify(content);
}

export function ingestEntries(
  store: IngestStore,
  entries: readonly IngestibleEntry[],
  opts?: {
    externalize?: { largeFileChars: number };
  },
): IngestStats {
  let inserted = 0;
  let skipped = 0;
  const piCompactions: string[] = [];
  const files: ExternalizedFile[] = [];
  const largeInline: Array<{ entryId: string; chars: number }> = [];
  const policy = opts?.externalize;
  for (const e of entries) {
    if (!isIngestible(e) || store.hasEntry(e.entryId)) {
      skipped++;
      continue;
    }
    // Verbatim, whatever the size: the original has to survive for the reader.
    // Masking happens at the read seams (FTS_PREFIX_CHARS, compaction-engine).
    const text = e.text;
    const payload = e.payload;
    const id = store.insertMessage({
      entryId: e.entryId,
      role: e.role,
      text,
      tokens: estimateTokens(text),
      timestamp: e.timestamp,
      ...(payload === undefined ? {} : { payload }),
    });
    inserted++;
    if (e.piCompaction) piCompactions.push(e.entryId);
    if (policy && id > 0 && text.length >= policy.largeFileChars) {
      if (e.fileHint === undefined) {
        largeInline.push({ entryId: e.entryId, chars: text.length });
      } else {
        const d = describeFile(e.fileHint.path, text);
        store.insertFile(d, e.entryId);
        store.linkMessageFile(id, d.fileId);
        files.push({
          entryId: e.entryId,
          fileId: d.fileId,
          path: d.path,
          kind: d.kind,
          bytes: d.bytes,
        });
      }
    }
  }
  return { inserted, skipped, piCompactions, files, largeInline };
}
