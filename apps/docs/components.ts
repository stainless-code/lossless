import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    // Docs pages have no site footer; the landing page slots its own through
    // PageLayout, and the 404 page keeps the default footer. String paths, so
    // the `.astro` files stay out of this TypeScript project: Vite+'s type
    // program has no `*.astro` module declaration and Blume resolves a path
    // against the project root the same way.
    Header: "./components/blume/Header.astro",
    Footer: "./components/blume/EmptyFooter.astro",
    Pagination: "./components/blume/Pagination.astro",
    Sidebar: "./components/blume/Sidebar.astro",
  },
  mdx: {
    FaqSection: "./components/seo/FaqSection.astro",
    HarnessCards: "./components/mdx/HarnessCards.astro",
    DagFigure: "./components/visuals/DagFigure.astro",
    EscalationLadder: "./components/visuals/EscalationLadder.astro",
    RecallFlow: "./components/visuals/RecallFlow.astro",
    WindowFigure: "./components/visuals/WindowFigure.astro",
  },
});
