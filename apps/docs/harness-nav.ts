import { withBase } from "blume/components/islands/base-path.ts";

import { OPENCODE_ICON } from "./harness-icons.ts";

export type HostId = "pi" | "opencode";

export interface Host {
  id: HostId;
  label: string;
  description: string;
  icon: string;
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
];

export const under = (route: string, prefix: string): boolean =>
  route === prefix || route.startsWith(`${prefix}/`);

export const hostFromRoute = (route: string): HostId | undefined => {
  if (under(route, "/guides/pi") || under(route, "/reference/pi")) return "pi";
  if (under(route, "/guides/opencode") || under(route, "/reference/opencode")) {
    return "opencode";
  }
  return undefined;
};
