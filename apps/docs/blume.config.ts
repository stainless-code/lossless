import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "blume";

import { CURATED_POPULAR } from "./components/curated-popular.js";

const title = "Lossless";
const description =
  "Lossless Context Management for coding agents, starting with Pi. Aged history becomes summary pointers, and every message stays verbatim and searchable";
/** Custom `.astro` pages have no frontmatter, so the OG cards are named here
 * (Blume would otherwise use the humanized segment). */
const homeTitle = `${title}: nothing is lost, the model sees less`;
const notFoundTitle = "Page not found";

/** Mount point of the deployed site, shared with every absolute href below. */
const deploymentBase = "/lossless";

/**
 * Blume declares the icons it resolves from `public/` and nothing else: there is
 * no config key for a web app manifest or for the iOS home-screen title, and the
 * icon set ships assets for both, so the deployed pages declare the pair
 * themselves.
 *
 * The catalog links need the same treatment for a different reason: since 1.7.3
 * Blume renders them in RootLayout's head, which the docs pages use, but
 * PageLayout — which the home and 404 pages use — has no equivalent, so the pair
 * is declared here on the pages that don't already carry it.
 *
 * Astro runs no HTML transform of ours over prerendered pages: the Vite
 * `transformIndexHtml` hook an integration can register never sees them, so the
 * declarations are appended to the built files once the build is done. The dev
 * server's HTML stays as it is, because it is not the artifact a manifest
 * describes.
 */
const webAppHeadIntegration = {
  name: "lossless-web-app-head",
  hooks: {
    "astro:build:done": async ({ dir }: { dir: URL }) => {
      const root = fileURLToPath(dir);
      const tags = [
        `<link rel="manifest" href="${deploymentBase}/site.webmanifest">`,
        `<meta name="apple-mobile-web-app-title" content="${title}">`,
        `<link rel="ai-catalog" href="${deploymentBase}/.well-known/ai-catalog.json" type="application/ai-catalog+json">`,
        `<link rel="ard" href="${deploymentBase}/.well-known/ard.json" type="application/json">`,
      ];
      for (const entry of await readdir(root, { recursive: true })) {
        if (!entry.endsWith(".html")) {
          continue;
        }
        const file = join(root, entry);
        const html = await readFile(file, "utf8");
        if (!html.includes("</head>")) {
          continue;
        }
        // Docs pages already carry the catalog pair from RootLayout: only the
        // missing declarations go in, so nothing is doubled up.
        const missing = tags.filter((tag) => {
          const rel = /rel="([^"]+)"/.exec(tag)?.[1];
          return rel === undefined || !html.includes(`rel="${rel}"`);
        });
        if (missing.length === 0) {
          continue;
        }
        await writeFile(file, html.replace("</head>", `${missing.join("\n    ")}\n  </head>`));
      }
    },
  },
};

export default defineConfig({
  title,
  description,

  logo: { image: "/logo.svg", text: title },

  github: {
    owner: "stainless-code",
    repo: "lossless",
    branch: "main",
    dir: "apps/docs",
  },

  lastModified: true,

  content: {
    sources: [{ type: "filesystem", root: "content" }],
  },

  integrations: [webAppHeadIntegration],

  navigation: {
    tabs: [
      { label: "Guides", path: "/guides", icon: "book-open" },
      { label: "Concepts", path: "/concepts", icon: "lightbulb" },
      { label: "Reference", path: "/reference", icon: "code" },
    ],
    featured: [
      {
        label: "Comparison",
        href: "/reference/comparison",
        icon: "scale",
      },
      {
        label: "GitHub",
        href: "https://github.com/stainless-code/lossless",
        icon: "github",
      },
    ],
    sidebar: { display: "flat" },
  },

  theme: {
    accent: { light: "#6d28d9", dark: "#c4b5fd" },
    background: { light: "#fafafa", dark: "#18181b" },
    radius: "sm",
    mode: "system",
    fonts: {
      display: "inter-tight",
      body: "inter",
      mono: "geist-mono",
    },
  },

  search: {
    provider: "orama",
    popular: CURATED_POPULAR.map(({ route, label }) => ({ href: route, label })),
  },

  markdown: {
    code: { icons: true },
    codeBlocks: { theme: { light: "github-light", dark: "github-dark" } },
  },

  toc: { minHeadingLevel: 2, maxHeadingLevel: 3 },

  export: { epub: true, pdf: true },

  ai: { llmsTxt: true },

  seo: {
    og: {
      enabled: true,
      titles: { "/": homeTitle, "/404": notFoundTitle },
    },
    sitemap: true,
    robots: true,
    structuredData: true,
    agentReadability: true,
  },

  deployment: {
    output: "static",
    site: "https://stainless-code.com",
    base: deploymentBase,
  },
});
