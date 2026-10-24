import { summarizeWithEscalation } from "lossless-core";
import type { LlmComplete } from "lossless-core";
import { describe, expect, it } from "vite-plus/test";

import { dshModelHost } from "../src/model-host.ts";
import type { DshRoute } from "../src/model-host.ts";
import { cappedChunks, errorChunks, setupContext, textChunks } from "./support/script-adapter.ts";

const ROUTE: DshRoute = { provider: "test-provider", model: "test-model" };

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
