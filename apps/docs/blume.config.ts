import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "blume";
import { orama } from "blume/search";
import { filesystem } from "blume/sources";

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

// Prerendered pages skip transformIndexHtml, so append tags to dist after build.
const webAppHeadIntegration = {
  name: "lossless-web-app-head",
  hooks: {
    "astro:build:done": async ({ dir }: { dir: URL }) => {
      const root = fileURLToPath(dir);
      const tags = [
        `<link rel="manifest" href="${deploymentBase}/site.webmanifest">`,
        `<meta name="apple-mobile-web-app-title" content="${title}">`,
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
        const missing = tags.filter((tag) => {
          const rel = /rel="([^"]+)"/.exec(tag)?.[1];
          if (rel !== undefined) {
            return !html.includes(`rel="${rel}"`);
          }
          const name = /name="([^"]+)"/.exec(tag)?.[1];
          return name === undefined || !html.includes(name);
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

  lastModified: "git",

  content: {
    sources: [filesystem({ root: "content" })],
  },

  integrations: [webAppHeadIntegration],

  navigation: {
    tabs: [
      { label: "Guides", path: "/guides" },
      { label: "Concepts", path: "/concepts" },
      { label: "Reference", path: "/reference" },
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

  footer: {
    links: [
      { label: "Comparison", href: "/reference/comparison" },
      { label: "Roadmap", href: "/reference/roadmap" },
      { label: "npm", href: "https://npmx.dev/package/pi-lossless" },
      {
        label: "MIT license",
        href: "https://github.com/stainless-code/lossless/blob/main/LICENSE",
      },
    ],
    socials: {
      website: "https://stainless-code.com",
    },
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
    provider: orama(),
    popular: CURATED_POPULAR.map(({ route, label }) => ({ href: route, label })),
  },

  markdown: {
    externalLinks: true,
    code: {
      icons: true,
      theme: { light: "github-light", dark: "github-dark" },
    },
  },

  toc: { minHeadingLevel: 2, maxHeadingLevel: 3 },

  export: { epub: true, pdf: true },

  agents: { llmsTxt: true, agentReadability: true },

  seo: {
    og: {
      enabled: true,
      titles: { "/": homeTitle, "/404": notFoundTitle },
    },
    sitemap: true,
    robots: true,
    structuredData: true,
  },

  deployment: {
    site: "https://stainless-code.com",
    base: deploymentBase,
  },
});
