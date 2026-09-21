import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Reader } from "lossless-core";

import { piModelHost, piReader } from "../../src/host.ts";

export type RegistryFind = (provider: string, id: string) => unknown;

export type PiReply = (context: Context) => AssistantMessage | Promise<AssistantMessage>;

export interface PiDoubleOptions {
  registry?: Record<string, unknown>;
  model?: unknown;
  notify?: (message: string, level?: string) => void;
  reply?: PiReply;
}

const TEST_MODEL = { provider: "test", id: "test-model" };

/**
 * A context Pi would hand an extension, holding only the fields this package
 * reads, plus every context the adapter asked the model about. The real
 * `src/host/pi.ts` sits on top of it, so a test asserts what Pi would have seen
 * rather than what a second implementation of the seam decided to build.
 */
export function piDouble(opts?: PiDoubleOptions): {
  ctx: ExtensionContext;
  contexts: Context[];
  seenOptions: unknown[];
} {
  const contexts: Context[] = [];
  const seenOptions: unknown[] = [];
  const reply = opts?.reply;
  const scripted = (opts?.registry ?? {}) as {
    find?: (provider: string, id: string) => unknown;
    complete?: (model: unknown, context: Context, options?: unknown) => unknown;
  };
  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => scripted.find?.(provider, id),
      complete: async (model: unknown, context: Context, options?: unknown): Promise<unknown> => {
        // A snapshot, because the host keeps appending to its own transcript:
        // recording the live array would show every step the same final state
        // and hide a reply appended in the wrong order.
        contexts.push({ ...context, messages: [...context.messages] });
        seenOptions.push(options);
        if (scripted.complete) return scripted.complete(model, context, options);
        if (!reply) throw new Error("pi-double: no reply scripted");
        return reply(context);
      },
    },
    model: opts?.model,
    sessionManager: { getSessionId: () => "pi-test-session" },
    hasUI: opts?.notify !== undefined,
    ui: opts?.notify ? { notify: opts.notify } : undefined,
  } as unknown as ExtensionContext;
  return { ctx, contexts, seenOptions };
}

export function piHost(opts?: PiDoubleOptions) {
  return piModelHost(piDouble(opts).ctx);
}

export function readerFor(reply: PiReply): Reader {
  return piReader(piDouble({ model: TEST_MODEL, reply }).ctx, undefined);
}

export function scriptedReader(replies: AssistantMessage[]): {
  reader: Reader;
  contexts: Context[];
} {
  let index = 0;
  const double = piDouble({
    model: TEST_MODEL,
    reply: () => {
      const reply = replies[index];
      index += 1;
      if (!reply) throw new Error("script exhausted");
      return reply;
    },
  });
  return { reader: piReader(double.ctx, undefined), contexts: double.contexts };
}
