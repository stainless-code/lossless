import { homedir as osHomedir } from "node:os";
import { join, posix, win32 } from "node:path";

export type DefaultSidecarSource =
  | "default:XDG_DATA_HOME"
  | "default:home"
  | "default:LOCALAPPDATA"
  | "default:APPDATA"
  | "fallback";

export type DefaultSidecarEnv = Readonly<Record<string, string | undefined>>;

export interface ResolveDefaultSidecarDirInput {
  readonly env: DefaultSidecarEnv;
  readonly homedir: string | undefined;
  readonly platform: string;
}

export interface ResolvedDefaultSidecarDir {
  readonly dir: string;
  readonly source: DefaultSidecarSource;
}

/** This path stays relative. It resolves from the server working directory. */
export const FALLBACK_SIDECAR_DIR = "./.lossless";

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isAbsoluteForPlatform(path: string, platform: string): boolean {
  return platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

export function resolveDefaultSidecarDir(
  input: ResolveDefaultSidecarDirInput,
): ResolvedDefaultSidecarDir {
  const env = input.env;
  const xdg = nonBlank(env["XDG_DATA_HOME"]);
  if (xdg !== undefined && isAbsoluteForPlatform(xdg, input.platform)) {
    return { dir: join(xdg, "opencode", "lossless"), source: "default:XDG_DATA_HOME" };
  }
  const home = nonBlank(input.homedir);
  if (home !== undefined) {
    if (input.platform === "win32") {
      const local = nonBlank(env["LOCALAPPDATA"]);
      if (local !== undefined) {
        return { dir: join(local, "opencode", "lossless"), source: "default:LOCALAPPDATA" };
      }
      const roaming = nonBlank(env["APPDATA"]);
      if (roaming !== undefined) {
        return { dir: join(roaming, "opencode", "lossless"), source: "default:APPDATA" };
      }
      return {
        dir: join(home, "AppData", "Local", "opencode", "lossless"),
        source: "default:home",
      };
    }
    return {
      dir: join(home, ".local", "share", "opencode", "lossless"),
      source: "default:home",
    };
  }
  return { dir: FALLBACK_SIDECAR_DIR, source: "fallback" };
}

export function defaultSidecarDir(): ResolvedDefaultSidecarDir {
  try {
    return resolveDefaultSidecarDir({
      env: process.env,
      homedir: osHomedir(),
      platform: process.platform,
    });
  } catch {
    return { dir: FALLBACK_SIDECAR_DIR, source: "fallback" };
  }
}
