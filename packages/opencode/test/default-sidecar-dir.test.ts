import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  defaultSidecarDir,
  resolveDefaultSidecarDir,
  type DefaultSidecarEnv,
} from "../src/default-sidecar-dir.ts";
import { readOptions } from "../src/plugin.ts";

function resolve(
  env: DefaultSidecarEnv,
  homedir: string | undefined,
  platform: string,
): { dir: string; source: string } {
  return resolveDefaultSidecarDir({ env, homedir, platform });
}

describe("resolveDefaultSidecarDir", () => {
  it("prefers a non-blank absolute XDG_DATA_HOME", () => {
    expect(resolve({ XDG_DATA_HOME: "/data" }, "/home/u", "linux")).toEqual({
      dir: join("/data", "opencode", "lossless"),
      source: "default:XDG_DATA_HOME",
    });
  });

  it("treats an empty XDG_DATA_HOME as unset", () => {
    expect(resolve({ XDG_DATA_HOME: "" }, "/home/u", "linux")).toEqual({
      dir: join("/home/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("treats a whitespace-only XDG_DATA_HOME as unset", () => {
    expect(resolve({ XDG_DATA_HOME: "   " }, "/home/u", "linux")).toEqual({
      dir: join("/home/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("ignores a relative XDG_DATA_HOME", () => {
    expect(resolve({ XDG_DATA_HOME: "rel/path" }, "/home/u", "linux")).toEqual({
      dir: join("/home/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("ignores a Windows-style XDG_DATA_HOME on posix", () => {
    expect(resolve({ XDG_DATA_HOME: "C:\\data" }, "/home/u", "linux")).toEqual({
      dir: join("/home/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("ignores a relative XDG_DATA_HOME on win32", () => {
    const home = "C:\\Users\\u";
    expect(resolve({ XDG_DATA_HOME: "rel\\path" }, home, "win32")).toEqual({
      dir: join(home, "AppData", "Local", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("accepts a posix XDG_DATA_HOME on win32 under the win32 rule", () => {
    expect(resolve({ XDG_DATA_HOME: "/data" }, "C:\\Users\\u", "win32")).toEqual({
      dir: join("/data", "opencode", "lossless"),
      source: "default:XDG_DATA_HOME",
    });
  });

  it("falls back to the home share dir on darwin", () => {
    expect(resolve({}, "/Users/u", "darwin")).toEqual({
      dir: join("/Users/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("falls back to the home share dir on linux", () => {
    expect(resolve({}, "/home/u", "linux")).toEqual({
      dir: join("/home/u", ".local", "share", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("prefers LOCALAPPDATA on win32", () => {
    const local = "C:\\Users\\u\\AppData\\Local";
    expect(
      resolve(
        { LOCALAPPDATA: local, APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
        "C:\\Users\\u",
        "win32",
      ),
    ).toEqual({
      dir: join(local, "opencode", "lossless"),
      source: "default:LOCALAPPDATA",
    });
  });

  it("uses APPDATA on win32 when LOCALAPPDATA is unset", () => {
    const roaming = "C:\\Users\\u\\AppData\\Roaming";
    expect(resolve({ APPDATA: roaming }, "C:\\Users\\u", "win32")).toEqual({
      dir: join(roaming, "opencode", "lossless"),
      source: "default:APPDATA",
    });
  });

  it("treats a blank LOCALAPPDATA as unset on win32", () => {
    const roaming = "C:\\Users\\u\\AppData\\Roaming";
    expect(resolve({ LOCALAPPDATA: "   ", APPDATA: roaming }, "C:\\Users\\u", "win32")).toEqual({
      dir: join(roaming, "opencode", "lossless"),
      source: "default:APPDATA",
    });
  });

  it("uses home AppData Local on win32 when no env dir is set", () => {
    expect(resolve({}, "C:\\Users\\u", "win32")).toEqual({
      dir: join("C:\\Users\\u", "AppData", "Local", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("treats blank win32 env dirs as unset and uses home AppData Local", () => {
    expect(resolve({ LOCALAPPDATA: "", APPDATA: "  " }, "C:\\Users\\u", "win32")).toEqual({
      dir: join("C:\\Users\\u", "AppData", "Local", "opencode", "lossless"),
      source: "default:home",
    });
  });

  it("falls back to ./.lossless on win32 with no home", () => {
    expect(resolve({}, undefined, "win32")).toEqual({
      dir: "./.lossless",
      source: "fallback",
    });
  });

  it("falls back to ./.lossless with no home on posix", () => {
    expect(resolve({}, undefined, "linux")).toEqual({
      dir: "./.lossless",
      source: "fallback",
    });
  });
});

describe("readOptions sidecarDir", () => {
  it("passes an explicit relative dir through byte identical", () => {
    const options = readOptions({ sidecarDir: "./.lossless" });
    expect(options.sidecarDir).toBe("./.lossless");
    expect(options.sidecarSource).toBe("explicit");
  });

  it("passes an explicit absolute dir through byte identical", () => {
    const options = readOptions({ sidecarDir: "/tmp/lcm-abs" });
    expect(options.sidecarDir).toBe("/tmp/lcm-abs");
    expect(options.sidecarSource).toBe("explicit");
  });

  it("falls back to the default for a blank dir", () => {
    const expected = defaultSidecarDir();
    const options = readOptions({ sidecarDir: "   " });
    expect(options.sidecarDir).toBe(expected.dir);
    expect(options.sidecarSource).toBe(expected.source);
  });
});
