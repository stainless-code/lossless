import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  defaultSidecarDir,
  resolveDefaultSidecarDir,
  type DefaultSidecarEnv,
} from "../src/default-sidecar-dir.ts";
import { readSidecarDir } from "../src/plugin.ts";

function resolve(
  env: DefaultSidecarEnv,
  homedir: string | undefined,
): { dir: string; source: string } {
  return resolveDefaultSidecarDir({ env, homedir });
}

describe("resolveDefaultSidecarDir", () => {
  it("prefers a non-blank absolute DSH_HOME", () => {
    expect(resolve({ DSH_HOME: "/data" }, "/home/u")).toEqual({
      dir: join("/data", "lossless"),
      source: "default:DSH_HOME",
    });
  });

  it("treats an empty DSH_HOME as unset", () => {
    expect(resolve({ DSH_HOME: "" }, "/home/u")).toEqual({
      dir: join("/home/u", ".dsh", "lossless"),
      source: "default:home",
    });
  });

  it("treats a whitespace-only DSH_HOME as unset", () => {
    expect(resolve({ DSH_HOME: "   " }, "/home/u")).toEqual({
      dir: join("/home/u", ".dsh", "lossless"),
      source: "default:home",
    });
  });

  it("ignores a relative DSH_HOME", () => {
    expect(resolve({ DSH_HOME: "rel/path" }, "/home/u")).toEqual({
      dir: join("/home/u", ".dsh", "lossless"),
      source: "default:home",
    });
  });

  it("falls back to the home dir when DSH_HOME is unset", () => {
    expect(resolve({}, "/Users/u")).toEqual({
      dir: join("/Users/u", ".dsh", "lossless"),
      source: "default:home",
    });
  });

  it("treats a blank homedir as unset and falls back", () => {
    expect(resolve({}, "   ")).toEqual({
      dir: "./.lossless",
      source: "fallback",
    });
  });

  it("falls back to ./.lossless with no home", () => {
    expect(resolve({}, undefined)).toEqual({
      dir: "./.lossless",
      source: "fallback",
    });
  });

  it("falls back to ./.lossless with no home even when DSH_HOME is relative", () => {
    expect(resolve({ DSH_HOME: "rel/path" }, undefined)).toEqual({
      dir: "./.lossless",
      source: "fallback",
    });
  });
});

describe("defaultSidecarDir", () => {
  it("resolves without throwing", () => {
    const resolved = defaultSidecarDir();
    expect(typeof resolved.dir).toBe("string");
    expect(["default:DSH_HOME", "default:home", "fallback"]).toContain(resolved.source);
  });
});

describe("readSidecarDir", () => {
  it("passes an explicit relative dir through byte identical", () => {
    const options = readSidecarDir("./.lossless");
    expect(options.dir).toBe("./.lossless");
    expect(options.source).toBe("explicit");
  });

  it("passes an explicit absolute dir through byte identical", () => {
    const options = readSidecarDir("/tmp/lcm-abs");
    expect(options.dir).toBe("/tmp/lcm-abs");
    expect(options.source).toBe("explicit");
  });

  it("falls back to the default for a blank dir", () => {
    const expected = defaultSidecarDir();
    const options = readSidecarDir("   ");
    expect(options.dir).toBe(expected.dir);
    expect(options.source).toBe(expected.source);
  });

  it("falls back to the default when unset", () => {
    const expected = defaultSidecarDir();
    const options = readSidecarDir(undefined);
    expect(options.dir).toBe(expected.dir);
    expect(options.source).toBe(expected.source);
  });
});
