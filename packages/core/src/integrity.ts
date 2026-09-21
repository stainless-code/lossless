import { SCHEMA_VERSION, type IntegritySnapshot, type LcmStore } from "./store.ts";

const SAMPLE = 10;

export type FindingKind =
  | "fts-index"
  | "summary-span"
  | "summary-shape"
  | "orphan-child"
  | "duplicate-span"
  | "foreign-key"
  | "schema-version"
  | "dead-run"
  | "coverage";

export interface Finding {
  kind: FindingKind;
  /** `violation` is an invariant the DAG depends on; `coverage` is a count. */
  severity: "violation" | "info";
  count: number;
  detail: string;
  sample: string[];
}

export interface IntegrityReport {
  /** How many checks ran, so "no findings" cannot be confused with "no checks". */
  checks: number;
  findings: Finding[];
}

function sample(ids: number[]): string[] {
  return ids.slice(0, SAMPLE).map((id) => `#${id}`);
}

/** Every invariant the store can verify about itself. Each check reads through
 * `integritySnapshot`, so this module holds no SQL of its own and the cost is
 * one pass of counts and ids.
 *
 * There is deliberately no FTS drift check. The index is an external-content
 * FTS5 table, so `COUNT(*)` and `rowid` scans are answered from the content
 * table and report a healthy count for a drifted index, and `fts5vocab`
 * reports `doc: 1` for every term. Structural damage is what `integrity-check`
 * detects; content drift is repaired by the rebuild that `repairIntegrity`
 * always performs. */
type Check<K extends FindingKind> = (
  snap: IntegritySnapshot,
) => (Finding & { kind: K }) | undefined;

const CHECKS: { readonly [K in FindingKind]: Check<K> } = {
  "fts-index": (snap) =>
    snap.ftsOk
      ? undefined
      : {
          kind: "fts-index",
          severity: "violation",
          count: 1,
          detail: "the full-text index failed its own integrity check or could not be read",
          sample: [],
        },

  "summary-span": (snap) => {
    const unresolved = snap.spans.filter((s) => s.firstRowid === null || s.lastRowid === null);
    if (unresolved.length === 0) return undefined;
    return {
      kind: "summary-span",
      severity: "violation",
      count: unresolved.length,
      detail:
        "these summaries name an entry the store does not hold, so no frontier can select them",
      sample: unresolved.slice(0, SAMPLE).map((s) => `#${s.id}`),
    };
  },

  "summary-shape": (snap) => {
    const shapes = snap.shapes.filter(
      (s) =>
        (s.kind === "leaf" && s.depth !== 0) ||
        (s.kind === "leaf" && s.messages === 0) ||
        (s.kind === "condensed" && s.children === 0),
    );
    const inverted = snap.spans.filter(
      (s) => s.firstRowid !== null && s.lastRowid !== null && s.firstRowid > s.lastRowid,
    );
    if (shapes.length === 0 && inverted.length === 0) return undefined;
    const parts = [
      ...(shapes.length > 0
        ? [`${shapes.length} with a depth or provenance the DAG cannot walk`]
        : []),
      ...(inverted.length > 0 ? [`${inverted.length} whose span ends before it starts`] : []),
    ];
    // One node can be both, so the count and the sample name nodes and the
    // detail names reasons.
    const ids = [...new Set([...shapes, ...inverted].map((s) => `#${s.id}`))];
    return {
      kind: "summary-shape",
      severity: "violation",
      count: ids.length,
      detail: parts.join("; "),
      sample: ids.slice(0, SAMPLE),
    };
  },

  // A committed node that names a summary child which is gone cannot be walked:
  // expanding it loses the span underneath the child, so the DAG's own shape is
  // broken rather than merely incomplete.
  "orphan-child": (snap) =>
    snap.orphanChildParents.length === 0
      ? undefined
      : {
          kind: "orphan-child",
          severity: "violation",
          count: snap.orphanChildParents.length,
          detail: `${snap.orphanChildParents.length} node(s) name a summary child that is gone`,
          sample: sample(snap.orphanChildParents),
        },

  // Pending rows belong to a run and no reader can see them, so a run whose writer
  // is gone is work to clear rather than an invariant in doubt. What is counted is
  // the work item, a run or an untracked row, so a pass killed before it wrote
  // anything is still named rather than reported as zero of something.
  "dead-run": (snap) => {
    const held = snap.deadRuns.flatMap((r) => r.rows);
    const count = snap.deadRuns.length + snap.untrackedPending.length;
    if (count === 0) return undefined;
    if (snap.deadRuns.length === 0) {
      return {
        kind: "dead-run",
        severity: "info",
        count,
        detail: `${count} pending row(s) name no run at all`,
        sample: sample(snap.untrackedPending),
      };
    }
    const sessions = [...new Set(snap.deadRuns.map((r) => r.session ?? "unnamed"))];
    return {
      kind: "dead-run",
      severity: "info",
      count,
      detail:
        `${snap.deadRuns.length} run(s) whose writer is gone hold ${held.length} pending row(s)` +
        (snap.untrackedPending.length === 0
          ? ""
          : `, and ${snap.untrackedPending.length} row(s) name no run`) +
        `; session(s) ${sessions.join(", ")}`,
      sample: sample(held.concat(snap.untrackedPending)),
    };
  },

  "duplicate-span": (snap) =>
    snap.duplicateSpans.length === 0
      ? undefined
      : {
          kind: "duplicate-span",
          severity: "violation",
          count: snap.duplicateSpans.reduce((n, d) => n + d.count, 0),
          detail: `${snap.duplicateSpans.length} span(s) are claimed by more than one node, which the span index should prevent`,
          sample: snap.duplicateSpans
            .slice(0, SAMPLE)
            .map((d) => `${d.first}..${d.last} (${d.kind}) x${d.count}`),
        },

  "foreign-key": (snap) =>
    snap.foreignKeyViolations === 0
      ? undefined
      : {
          kind: "foreign-key",
          severity: "violation",
          count: snap.foreignKeyViolations,
          detail: "the database holds rows whose referenced row is gone",
          sample: [],
        },

  "schema-version": (snap) =>
    snap.schemaVersion === SCHEMA_VERSION
      ? undefined
      : {
          kind: "schema-version",
          severity: "violation",
          count: 1,
          detail: `recorded version ${snap.schemaVersion}, this build writes ${SCHEMA_VERSION}`,
          sample: [],
        },

  // A message with no leaf is the normal state before the first pass, so this
  // is reported and never treated as a violation.
  coverage: (snap) =>
    snap.uncoveredMessages === 0
      ? undefined
      : {
          kind: "coverage",
          severity: "info",
          count: snap.uncoveredMessages,
          detail: `${snap.uncoveredMessages} of ${snap.messageRows} message(s) have no leaf yet`,
          sample: [],
        },
};

export function checkIntegrity(store: LcmStore): IntegrityReport {
  const snap = store.integritySnapshot();
  const findings: Finding[] = [];
  for (const check of Object.values(CHECKS)) {
    const finding = check(snap);
    if (finding) findings.push(finding);
  }
  return { checks: Object.keys(CHECKS).length, findings };
}

/** Fix what can be fixed without guessing: the derived index, rows whose span no
 * longer exists, nodes whose child no longer resolves, rows a run whose writer is
 * gone left behind, and predated duplicate spans. An inverted span is left
 * alone, because which end is right needs the session file. */
export function repairIntegrity(store: LcmStore): string[] {
  const notes: string[] = [];
  const before = store.integritySnapshot();
  try {
    store.rebuildFts();
    notes.push(`rebuilt the full-text index (${before.messageRows} row(s) from messages)`);
  } catch (error) {
    notes.push(
      `could not rebuild the full-text index: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dropped = store.deleteOrphanSpans();
  if (dropped > 0) notes.push(`dropped ${dropped} summar(y|ies) with an unresolvable span`);
  const deduped = store.dedupeSpans();
  if (deduped > 0) notes.push(`dropped ${deduped} duplicate span row(s)`);
  const reaped = store.reapDeadRuns();
  // A reap can leave a committed node naming a row it just dropped, so the orphan
  // sweep runs after it and clears both in one call. A run killed before it wrote
  // anything is a dead run with no rows, so the note counts runs as well.
  const dead = before.deadRuns.length;
  if (reaped > 0 || dead > 0) {
    notes.push(`reaped ${reaped} pending row(s) and cleared ${dead} run(s) whose writer is gone`);
  }
  const unlinked = store.deleteOrphanChildren();
  if (unlinked > 0) notes.push(`dropped ${unlinked} summar(y|ies) whose child no longer resolves`);
  return notes;
}
