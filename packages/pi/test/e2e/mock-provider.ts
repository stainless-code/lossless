import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Points Pi at the mock server the test process runs. The base url travels in
 * the environment so the test owns the recording and this file stays a shim.
 * The model's window is small on purpose: the test needs a swap, not a long
 * conversation. */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("mock", {
    name: "Mock",
    baseUrl: process.env.LCM_E2E_BASE_URL ?? "http://127.0.0.1:1/v1",
    apiKey: "$LCM_E2E_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "mock-1",
        name: "Mock 1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4000,
        maxTokens: 512,
      },
    ],
  });
}
