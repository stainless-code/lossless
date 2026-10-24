/** Shared redaction seam for every harness adapter. Pi passes its live
 * config getter so a cockpit toggle takes effect immediately; OpenCode
 * passes its resolved plugin options (which today carry no flag, so the
 * adapter always redacts, preserving the current ignore-flag behavior in
 * one central place). Both shapes flow into core's `makeRedact`, so the
 * flag check lives here, not at each call site. */

import { makeRedact } from "../redact.ts";

/** Flag carrier both adapters satisfy: unset redacts, `false` disables. */
export interface RedactConfig {
  readonly redactSecrets?: boolean;
}

/** One adapter for `piConfig` (via getter) and `opencodeOpts` (via value):
 * a config value or a getter for one, out a `(text) => string` redactor. */
export function makeRedactConfigAdapter(
  config: RedactConfig | (() => RedactConfig),
): (text: string) => string {
  const get = typeof config === "function" ? config : (): RedactConfig => config;
  return makeRedact(get);
}
