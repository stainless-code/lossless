/** Sidebar marks for the harness groups. The two official files per harness are
 * selected by the site theme (`data-theme`), not by `currentColor` or the
 * operating-system media query an `<img>` would use. */
const icon = (name: string, light: string, dark: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 14 14"><style>.${name}-light{display:inline}.${name}-dark{display:none}:root[data-theme="dark"] .${name}-light{display:none}:root[data-theme="dark"] .${name}-dark{display:inline}</style><image class="${name}-light" href="/lossless/logos/${light}" width="14" height="14" preserveAspectRatio="xMidYMid meet"/><image class="${name}-dark" href="/lossless/logos/${dark}" width="14" height="14" preserveAspectRatio="xMidYMid meet"/></svg>`;

export const PI_ICON = icon("cmp-pi", "pi-light.svg", "pi-dark.svg");
export const OPENCODE_ICON = icon("cmp-opencode", "opencode-light.svg", "opencode-dark.svg");
export const DEEPSEEK_ICON = icon("cmp-deepseek", "deepseek.svg", "deepseek.svg");
