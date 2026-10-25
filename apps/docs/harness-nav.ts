import { withBase } from "blume/components/islands/base-path.ts";

import { DEEPSEEK_ICON, OPENCODE_ICON } from "./harness-icons.ts";

export type HostId = "pi" | "opencode" | "deepseek";

export interface Host {
  id: HostId;
  label: string;
  description: string;
  icon: string;
  /**
   * Static entry route used when the current section holds no group for this
   * host. DeepSeek ships reference only, so the guides-shaped default would
   * link a page that does not exist. Mirrors the first entry of
   * `content/reference/deepseek/meta.ts`.
   */
  entry?: string;
}

export const HOSTS: readonly Host[] = [
  {
    id: "pi",
    label: "Pi",
    description: "The Pi extension",
    icon: withBase("/logos/pi-color.svg"),
  },
  {
    id: "opencode",
    label: "OpenCode v2",
    description: "The OpenCode plugin",
    icon: OPENCODE_ICON,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "The DeepSeek adapter",
    icon: DEEPSEEK_ICON,
    entry: "/reference/deepseek/tools",
  },
];

export const under = (route: string, prefix: string): boolean =>
  route === prefix || route.startsWith(`${prefix}/`);

export const hostFromRoute = (route: string): HostId | undefined => {
  if (under(route, "/guides/pi") || under(route, "/reference/pi")) return "pi";
  if (under(route, "/guides/opencode") || under(route, "/reference/opencode")) {
    return "opencode";
  }
  if (under(route, "/reference/deepseek")) return "deepseek";
  return undefined;
};
