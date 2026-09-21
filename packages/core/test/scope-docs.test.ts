import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test } from "vite-plus/test";

import { SEARCH_SCOPE_HELP } from "../src/sessions.ts";

/** The cross-session guide, the human telling of the scope contract the tool
 * schema states in one sentence. The prose stays human; this test only pins
 * that every scope the schema promises is documented, with its meaning. */
const GUIDE = fileURLToPath(
  new URL("../../../apps/docs/content/guides/cross-session-recall.mdx", import.meta.url),
);

function scopes(): string[] {
  const seen = new Set<string>();
  for (const m of SEARCH_SCOPE_HELP.matchAll(/\b(session|sessions|all_sessions)\b/g)) {
    seen.add(m[1] as string);
  }
  return [...seen];
}

test("scope docs: the guide documents every scope the tool schema promises", () => {
  const promised = scopes();
  assert.ok(promised.length >= 3, `schema promises scopes: ${promised.join(", ")}`);
  const guide = readFileSync(GUIDE, "utf8");
  for (const scope of promised) {
    assert.ok(
      guide.includes(`"${scope}"`),
      `guide never names the "${scope}" scope SEARCH_SCOPE_HELP promises`,
    );
  }
});

test("scope docs: the guide keeps the scope meanings and the pointer rule", () => {
  const guide = readFileSync(GUIDE, "utf8");
  assert.ok(
    /"sessions"[^\n]*working directory|"sessions"[\s\S]{0,200}working directory/.test(guide),
  );
  assert.ok(/"all_sessions"[\s\S]{0,200}(every project|machine)/.test(guide));
  assert.ok(/pointer/i.test(guide), "guide lost the pointer-not-text rule");
  assert.ok(/lcm_expand_query/.test(guide), "guide lost the pointer reader");
  assert.ok(
    /never injected|not text|rather than text/i.test(guide),
    "guide lost the never-injected rule",
  );
});
