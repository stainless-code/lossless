import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const GUARD_FLAG = "LCM_TEST_GUARD";
/** Escape hatch for a live session that carries a test signal for another
 * reason, so the guard can never brick one. */
export const ALLOW_REAL_HOME_FLAG = "LCM_ALLOW_REAL_HOME";

/** Why this process looks like a test run, or undefined when it does not. A
 * runner that skips `test/setup.ts` still sets `NODE_ENV`, which is what makes
 * the guard independent of which runner started the process. */
function testRunSignal(): string | undefined {
  if (process.env[GUARD_FLAG] === "1") return `${GUARD_FLAG}=1`;
  if (process.env.VITEST !== undefined) return "VITEST";
  if (process.env.NODE_ENV === "test") return "NODE_ENV=test";
  return undefined;
}

function contains(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

export function isUnderTempDir(path: string): boolean {
  const bases = [tmpdir()];
  try {
    // macOS hands out /var/folders while realpath answers /private/var/folders.
    bases.push(realpathSync(tmpdir()));
  } catch {}
  return bases.some((base) => contains(base, path));
}

/** Every path this extension touches under the user's home resolves here, so one
 * guard covers them all instead of one per call site. A test run refuses a path
 * outside its temp home rather than touching the real config. */
export function lcmHomePath(...segments: string[]): string {
  const path = join(homedir(), ".pi", "agent", ...segments);
  const signal = testRunSignal();
  if (signal === undefined || process.env[ALLOW_REAL_HOME_FLAG] === "1") return path;
  if (isUnderTempDir(path)) return path;
  throw new Error(
    `LCM refused ${path}: this looks like a test run (${signal}) and the path is outside ${tmpdir()}. Set ${ALLOW_REAL_HOME_FLAG}=1 to use it anyway.`,
  );
}
