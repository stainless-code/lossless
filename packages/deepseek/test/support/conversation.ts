import { createMessage, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";

import type { DshRoute } from "../../src/model-host.ts";

/** Two closed turns with a system head and a routed request header. Works on
 * detached and live sessions alike; the caller opens the turn the engine
 * writes into. */
export function appendConversation(session: Session, route: DshRoute, text: string): void {
  session.append("turn/start", { turn: 1 });
  session.append(
    "system/message",
    { turn: 1, step: 1, message: createSystemMessage("You are a test.") },
    { surfaceOp: "append" },
  );
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: `${text} first request` }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 1, step: 1 });
  session.append("request/header", {
    header: { config: { provider: route.provider, model: route.model } },
    reason: "initial",
  });
  session.append(
    "assistant/message",
    {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [{ type: "text", text: `${text} first response` }],
        source: { kind: "model", provider: route.provider, model: route.model },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  session.append("turn/start", { turn: 2 });
  session.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: `${text} second request` }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  session.append("step/start", { turn: 2, step: 1 });
  session.append(
    "assistant/message",
    {
      stream: [],
      turn: 2,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [{ type: "text", text: `${text} second response` }],
        source: { kind: "model", provider: route.provider, model: route.model },
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 2, step: 1 });
  session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
}
