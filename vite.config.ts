import { fileURLToPath } from "node:url";

import { defineConfig } from "vite-plus";

const coreSourceForTests = fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  fmt: {
    sortImports: true,
    sortPackageJson: true,
    ignorePatterns: ["apps/docs/content/**"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["apps/docs/content/**"],
  },
  staged: {
    "*.{js,ts,md,json,yml,yaml}": "vp check --fix",
  },
  resolve: {
    alias: { "lossless-core": coreSourceForTests },
  },
  test: {
    setupFiles: ["./packages/core/test/setup.ts"],
    include: ["packages/*/test/**/*.test.ts"],
  },
});
