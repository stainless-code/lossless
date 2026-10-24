import { describe, expect, it } from "vite-plus/test";

import type { GenerateText, ModelDomain, ModelRef, OpencodeContext } from "../src/host.ts";
import { modelKey, opencodeModelHost } from "../src/model-host.ts";
import { fakeHost } from "./support/opencode-fake.ts";

const CURRENT: ModelRef = { providerID: "test", id: "m1", variant: "high" };
const CATALOGUE: ModelDomain = {
  get: (providerID, modelID) =>
    providerID === "test" && modelID === "m1"
      ? { providerID: "test", id: "m1", limit: { context: 200_000, output: 32_000 } }
      : undefined,
  list: () => Promise.resolve({ data: [] }),
};

function ctxWith(overrides: Partial<OpencodeContext>): OpencodeContext {
  return { ...fakeHost().ctx, ...overrides };
}

describe("modelKey", () => {
  it("spells the model provider/id without the variant", () => {
    expect(modelKey({ key: "ignored", reasoning: false, model: CURRENT })).toBe("test/m1");
  });
});

describe("opencodeModelHost", () => {
  it("reports the session model as the auto ref", () => {
    const host = opencodeModelHost(ctxWith({}), CURRENT);
    expect(host.notices).toEqual({ kind: "none" });
    expect(host.session()).toEqual({ key: "test/m1", reasoning: false, model: CURRENT });
  });

  it("resolves a catalogue entry, keeping the running variant on the same model", () => {
    const host = opencodeModelHost(ctxWith({ model: CATALOGUE }), CURRENT);
    expect(host.find({ provider: "test", id: "m1" })).toEqual({
      key: "test/m1",
      reasoning: false,
      model: CURRENT,
    });
    expect(host.find({ provider: "test", id: "m2" })).toBeUndefined();
  });

  it("resolves nothing when the host exposes no synchronous lookup", () => {
    const host = opencodeModelHost(ctxWith({}), CURRENT);
    expect(host.find({ provider: "test", id: "m1" })).toBeUndefined();
  });

  it("forwards the prompt and model, and reports the answer", async () => {
    const calls: unknown[] = [];
    const generate: GenerateText = {
      text: (input) => {
        calls.push(input);
        return Promise.resolve({ text: "the summary" });
      },
    };
    const host = opencodeModelHost(ctxWith({ generate }), CURRENT);
    const answer = await host.complete(host.session()!, { prompt: "summarize", maxTokens: 64 });
    expect(answer).toEqual({
      outcome: "answer",
      text: "the summary",
      stop: "unknown",
      usage: {
        input: 3,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        estimated: true,
        totalTokens: 6,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    expect(calls).toEqual([{ prompt: "summarize", model: CURRENT }]);
    expect(calls[0]).not.toHaveProperty("maxTokens");
  });

  it("maps a throw to a failed answer and keeps usage undefined", async () => {
    const ctx = ctxWith({
      generate: { text: () => Promise.reject(new Error("provider down")) },
    });
    const host = opencodeModelHost(ctx, CURRENT);
    const answer = await host.complete(host.session()!, { prompt: "summarize", maxTokens: 64 });
    expect(answer).toEqual({
      outcome: "failed",
      reason: "provider down",
      capped: false,
      stop: "error",
      usage: undefined,
    });
  });

  it("fails clearly when the context has no generate.text", async () => {
    const host = opencodeModelHost(ctxWith({}), CURRENT);
    const answer = await host.complete(host.session()!, { prompt: "summarize", maxTokens: 64 });
    expect(answer.outcome).toBe("failed");
    if (answer.outcome !== "failed") return;
    expect(answer.reason).toContain("generate.text");
    expect(answer.usage).toBeUndefined();
  });
});
