import type { Agent } from "@deepseek-ai/dsh-agent";
import { summarizeWithEscalation } from "lossless-core";
import type { LlmComplete } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { agentRoute, dshModelHost } from "../src/model-host.ts";
import type { DshRoute } from "../src/model-host.ts";
import { cappedChunks, errorChunks, setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

function stubAgent(header: unknown, options?: unknown): Agent {
  return {
    session:
      header === undefined
        ? {}
        : {
            requestHeader: () => ({ config: header }),
          },
    options,
  } as unknown as Agent;
}

describe("agentRoute", () => {
  it("prefers the latest routed header over agent options", () => {
    const agent = stubAgent(
      { provider: "header-provider", model: "header-model" },
      { provider: "options-provider", model: "options-model" },
    );
    expect(agentRoute(agent)).toEqual({ provider: "header-provider", model: "header-model" });
  });

  it("falls back to agent options without a header", () => {
    const agent = stubAgent(undefined, { provider: "options-provider", model: "options-model" });
    expect(agentRoute(agent)).toEqual({ provider: "options-provider", model: "options-model" });
  });

  it("returns undefined when nothing resolves", () => {
    expect(agentRoute(stubAgent(undefined, undefined))).toBeUndefined();
    expect(agentRoute(undefined)).toBeUndefined();
  });

  it("falls back to options when requestHeader throws", () => {
    const agent = {
      session: {
        requestHeader: () => {
          throw new Error("header blew up");
        },
      },
      options: { provider: "options-provider", model: "options-model" },
    } as unknown as Agent;
    expect(agentRoute(agent)).toEqual({ provider: "options-provider", model: "options-model" });
  });

  it("ignores malformed header strings and returns undefined", () => {
    const agent = stubAgent({ provider: 42, model: "" }, undefined);
    expect(agentRoute(agent)).toBeUndefined();
  });
});

describe("dshModelHost.complete", () => {
  it("answers with text assembled from the chunk stream", async () => {
    const { ctx, adapter } = setupContext(ROUTE, [textChunks("hello summary")]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE });
    const ref = host.session();
    expect(ref?.key).toBe("test-provider/test-model");
    if (!ref) throw new Error("session route did not resolve");
    const answer = await host.complete(ref, { prompt: "summarize this", maxTokens: 100 });
    expect(answer).toMatchObject({
      outcome: "answer",
      text: "hello summary",
      stop: "stop",
      usage: {
        input: 10,
        output: 13,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 23,
      },
    });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      provider: "test-provider",
      model: "test-model",
      maxTokens: 100,
      purpose: "compaction",
    });
  });

  it("stamps the calling session id for per-conversation routing", async () => {
    const { ctx, adapter } = setupContext(ROUTE, [textChunks("hello summary")]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE, sessionId: "session-1" });
    const ref = host.session();
    if (!ref) throw new Error("session route did not resolve");
    await host.complete(ref, { prompt: "summarize this", maxTokens: 100 });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({ sessionId: "session-1" });
  });

  it("omits the session stamp when unset", async () => {
    const { ctx, adapter } = setupContext(ROUTE, [textChunks("hello summary")]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE });
    const ref = host.session();
    if (!ref) throw new Error("session route did not resolve");
    await host.complete(ref, { prompt: "summarize this", maxTokens: 100 });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).not.toHaveProperty("sessionId");
  });

  it("fails capped when the provider stops at its token cap", async () => {
    const { ctx } = setupContext(ROUTE, [cappedChunks("partial")]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE });
    const ref = host.session();
    if (!ref) throw new Error("session route did not resolve");
    const answer = await host.complete(ref, { prompt: "summarize this", maxTokens: 4 });
    expect(answer).toMatchObject({ outcome: "failed", capped: true, stop: "max-tokens" });
  });

  it("fails open with the provider code on an error finish", async () => {
    const { ctx } = setupContext(ROUTE, [errorChunks()]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE });
    const ref = host.session();
    if (!ref) throw new Error("session route did not resolve");
    const answer = await host.complete(ref, { prompt: "summarize this", maxTokens: 100 });
    expect(answer.outcome).toBe("failed");
    if (answer.outcome !== "failed") throw new Error("expected a failed answer");
    expect(answer.capped).toBe(false);
    expect(answer.stop).toBe("error");
    expect(answer.reason).toContain("AUTH");
  });

  it("summarizes one span through the real escalation ladder", async () => {
    const { ctx } = setupContext(ROUTE, [textChunks("Decisions: ship it. File: src/a.ts.")]);
    const host = dshModelHost(ctx, { defaultRoute: ROUTE });
    const ref = host.session();
    if (!ref) throw new Error("session route did not resolve");
    const llm: LlmComplete = async (systemPrompt, userText, maxTokens) => {
      const answer = await host.complete(ref, {
        prompt: `${systemPrompt}\n\n${userText}`,
        maxTokens,
      });
      if (answer.outcome !== "answer") throw new Error(answer.reason);
      return answer.text;
    };
    const result = await summarizeWithEscalation(
      [{ role: "user", text: "working notes ".repeat(50) }],
      200,
      llm,
    );
    expect(result.level).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.text).toContain("ship it");
  });
});
