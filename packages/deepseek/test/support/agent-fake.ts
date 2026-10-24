import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";

import type { DshRoute } from "../../src/model-host.ts";

/** compactNow and compactRegion read session, options, and runMaintenance. A
 * real Agent needs the full runtime (inbox, dispatcher); the harness compacts
 * its own suite the same way, with a minimal fake cast to the runtime type. */
export function fakeAgent(session: Session, route: DshRoute): Agent {
  return {
    session,
    options: { provider: route.provider, model: route.model },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal);
    },
  } as unknown as Agent;
}
