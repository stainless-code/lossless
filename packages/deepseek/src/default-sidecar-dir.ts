import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

export type DefaultSidecarSource = "default:DSH_HOME" | "default:home" | "fallback";

export type DefaultSidecarEnv = Readonly<Record<string, string | undefined>>;

export interface ResolveDefaultSidecarDirInput {
  readonly env: DefaultSidecarEnv;
  readonly homedir: string | undefined;
}

export interface ResolvedDefaultSidecarDir {
  readonly dir: string;
  readonly source: DefaultSidecarSource;
}

/** This path stays relative. It resolves from the process working directory. */
export const FALLBACK_SIDECAR_DIR = "./.lossless";

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path);
}

/** Pure resolver for the default sidecar directory. Only a non-blank absolute
 * DSH_HOME wins; anything else falls through to the home dir, then fallback. */
export function resolveDefaultSidecarDir(
  input: ResolveDefaultSidecarDirInput,
): ResolvedDefaultSidecarDir {
  const dshHome = nonBlank(input.env["DSH_HOME"]);
  if (dshHome !== undefined && isAbsolutePath(dshHome)) {
    return { dir: join(dshHome, "lossless"), source: "default:DSH_HOME" };
  }
  const home = nonBlank(input.homedir);
  if (home !== undefined) {
    return { dir: join(home, ".dsh", "lossless"), source: "default:home" };
  }
  return { dir: FALLBACK_SIDECAR_DIR, source: "fallback" };
}

/** Resolve the default from the live process. Never throws: anything odd falls back to {@link FALLBACK_SIDECAR_DIR}. */
export function defaultSidecarDir(): ResolvedDefaultSidecarDir {
  try {
    return resolveDefaultSidecarDir({
      env: process.env,
      homedir: osHomedir(),
    });
  } catch {
    return { dir: FALLBACK_SIDECAR_DIR, source: "fallback" };
  }
}
