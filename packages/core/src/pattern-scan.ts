/** One row the pattern path scans. The text is the stored message, whole: the
 * FTS index holds a prefix, and reading only that is the defect this path
 * exists to fix. */
export interface ScannedRow {
  rowid: number;
  entryId: string;
  role: string;
  text: string;
  removed: boolean;
}

/** A row that matched, with the first match's position and how many the row
 * held. `partial` is set when the row was longer than the per-row cap, so a
 * reader knows the scan stopped before the end of that row. */
export interface PatternHit {
  row: ScannedRow;
  matches: number;
  at: number;
  partial: boolean;
  scannedChars: number;
}

export type PatternStop = "end" | "deadline" | "page";

export interface PatternScanOutcome {
  hits: PatternHit[];
  rows: number;
  partialRows: number;
  more: boolean;
  stopped: PatternStop;
  lastRowId?: number;
  lastEntryId?: string;
}

export interface PatternScanOptions {
  pattern: CompiledPattern;
  offset: number;
  limit: number;
  /** Characters of one row the scan reads. Above the FTS prefix on purpose,
   * below the size of an externalized body, and named on the hit when it bites. */
  perRowChars: number;
  deadlineAt: number;
  now: () => number;
}

/** The characters a caller can hand a regular expression. A row longer than this
 * is read up to the cap and the hit says so: a partial scan that looks complete
 * is the same defect as an index that stops at 100,000 characters. */
export const PATTERN_ROW_CHARS = 200_000;

/** How long one pattern call may scan. Long enough for a session's messages at
 * 200,000 characters a row, short enough that a pathological pattern is a slow
 * call rather than a hung session. */
export const PATTERN_DEADLINE_MS = 1_000;

export const PATTERN_PAGE_ROWS = 200;

/** Matches counted in one row before the scan moves on. A row that mentions a
 * path a thousand times is one hit line, and counting the thousandth costs the
 * deadline that the next row needs. */
export const MAX_MATCHES_PER_ROW = 100;

export function scanRows(rows: Iterable<ScannedRow>, opts: PatternScanOptions): PatternScanOutcome {
  const { pattern, offset, limit, perRowChars, deadlineAt, now } = opts;
  const hits: PatternHit[] = [];
  let skipped = 0;
  let scanned = 0;
  let partialRows = 0;
  let more = false;
  let stopped: PatternStop = "end";
  let last: ScannedRow | undefined;
  for (const row of rows) {
    scanned++;
    last = row;
    const window = row.text.length > perRowChars ? row.text.slice(0, perRowChars) : row.text;
    const partial = window.length < row.text.length;
    if (partial) partialRows++;
    pattern.lastIndex = 0;
    let first = -1;
    let matches = 0;
    for (;;) {
      if (now() >= deadlineAt) {
        stopped = "deadline";
        break;
      }
      const match = pattern.exec(window);
      if (match === null) break;
      if (first < 0) first = match.index;
      matches++;
      if (match[0].length === 0) pattern.lastIndex++;
      if (matches >= MAX_MATCHES_PER_ROW) break;
    }
    if (first >= 0) {
      // A hit found before the clock ran out is a hit: the row's partial result
      // stands, and the partial marker on it says the scan was cut.
      if (skipped < offset) skipped++;
      else if (hits.length >= limit) more = true;
      else hits.push({ row, matches, at: first, partial, scannedChars: window.length });
    }
    if (stopped === "deadline") break;
    if (more) {
      stopped = "page";
      break;
    }
  }
  return {
    hits,
    rows: scanned,
    partialRows,
    more,
    stopped,
    ...(last === undefined ? {} : { lastRowId: last.rowid, lastEntryId: last.entryId }),
  };
}

/** A pattern this module compiled and validated, so a scan cannot receive a
 * caller's own stateful `RegExp`. */
export type CompiledPattern = RegExp & { readonly __brand: "CompiledPattern" };

export type PatternCompileResult =
  | { ok: true; pattern: CompiledPattern }
  | { ok: false; reason: string };

/** Compile a caller's pattern, with `g` for iteration and `i` unless the caller
 * asked for case sensitivity, which is the reading the FTS path already has. A
 * refusal is returned before any row is read. */
export function compilePattern(pattern: string, caseSensitive: boolean): PatternCompileResult {
  if (pattern.length === 0) {
    return { ok: false, reason: "Pattern is empty; give it at least one character." };
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch (error) {
    return {
      ok: false,
      reason: `Invalid pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // A pattern that matches the empty string matches every row, which is never
  // what a reader meant and always the most expensive thing to do.
  compiled.lastIndex = 0;
  if (compiled.test("")) {
    return {
      ok: false,
      reason: `Pattern ${JSON.stringify(pattern)} matches the empty string; make it match at least one character.`,
    };
  }
  return { ok: true, pattern: compiled as CompiledPattern };
}
