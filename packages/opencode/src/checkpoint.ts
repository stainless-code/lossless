/** Reading back the checkpoint a compaction hook wrote. The stored compaction
 * message names the node ids the hook rendered, but not the text it handed the
 * host: the host renders the summary (plus any kept tail it re-expanded) into
 * the outgoing request itself. That rendered message is what the model saw, so
 * the projection adopts it byte for byte rather than re-rendering from storage
 * and hoping the two agree. */

import type { LcmStore, SummaryNode } from "lossless-core";

import type { StoredCheckpoint } from "./map.ts";

/** The host's own rendering of the checkpoint message, or undefined when the
 * outgoing draft does not begin with the stored checkpoint. The id is the
 * check: a different head means the draft and the stored history disagree, and
 * the caller leaves the request alone. */
export function checkpointText(
  messages: readonly unknown[],
  checkpoint: StoredCheckpoint,
): string | undefined {
  const head = messages[0];
  if (!isRecord(head) || head.role !== "user" || head.id !== checkpoint.messageID) return undefined;
  return textOf(head.content);
}

/** The nodes the marker names, in the order the checkpoint rendered them.
 * A node retention removed is skipped: the marker stays valid, and the
 * projection still re-applies the stored text. */
export function checkpointNodes(store: LcmStore, checkpoint: StoredCheckpoint): SummaryNode[] {
  const nodes: SummaryNode[] = [];
  for (const id of checkpoint.summaryIds) {
    const node = store.getSummary(id);
    if (node !== undefined) nodes.push(node);
  }
  return nodes;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.length === 0 ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content as readonly unknown[]) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    if (part.text.length > 0) parts.push(part.text);
  }
  const text = parts.join("\n\n");
  return text.length === 0 ? undefined : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
