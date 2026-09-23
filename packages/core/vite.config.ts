import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      resolveDepSubpath: true,
    },
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    outDir: "dist",
    target: "node22.19.0",
  },
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
