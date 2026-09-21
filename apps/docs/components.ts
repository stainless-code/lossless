import { defineComponents } from "blume";

export default defineComponents({
  layout: {
    // No layout.Footer: the homepage slots one, docs pages stay empty.
    // String paths, so the `.astro` files stay out of this TypeScript project:
    // Vite+'s type program has no `*.astro` module declaration and Blume
    // resolves a path against the project root the same way.
    Pagination: "./components/blume/Pagination.astro",
  },
  mdx: {
    FaqSection: "./components/seo/FaqSection.astro",
    DagFigure: "./components/visuals/DagFigure.astro",
    EscalationLadder: "./components/visuals/EscalationLadder.astro",
    RecallFlow: "./components/visuals/RecallFlow.astro",
    WindowFigure: "./components/visuals/WindowFigure.astro",
  },
});
