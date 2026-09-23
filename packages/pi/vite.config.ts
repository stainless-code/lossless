import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

/** The engine read as source for the package-local test run; `pack` resolves it
 * through node_modules, so nothing here reaches the tarball. */
const engine = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "lossless-core": engine },
  },
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
    setupFiles: ["../core/test/setup.ts"],
  },
});
