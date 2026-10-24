import { SidecarStores, type SidecarRef } from "lossless-core";

export type { SidecarRef };

/** One SQLite sidecar per OpenCode session, opened on first use and held for
 * the plugin lifetime. Reads through `peek` never create a store, so recall
 * tools against a session with no history answer explained instead of
 * conjuring an empty database file. */
export class Sidecars extends SidecarStores {
  constructor(dir: string) {
    super({ dir });
  }
}
