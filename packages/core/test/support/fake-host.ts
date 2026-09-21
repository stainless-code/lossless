import type {
  ModelAnswer,
  ModelHost,
  ModelRef,
  Reader,
  ReaderReply,
  ReaderRequest,
  ReaderResult,
} from "../../src/host.ts";

export interface FakeModel {
  readonly key: string;
  readonly reasoning?: boolean;
  readonly answer?: string;
}

export interface FakeHost {
  readonly host: ModelHost<string>;
  readonly calls: { model: string; prompt: string; maxTokens: number }[];
  readonly told: string[];
}

/**
 * exists so the port is proven satisfiable by something other than the single
 * implementation it was written against, not to replace `pi-double.ts`, which
 * keeps the adapter itself under test.
 */
export function fakeHost(models: readonly FakeModel[], session?: string): FakeHost {
  const calls: FakeHost["calls"] = [];
  const told: string[] = [];
  const refs = models.map((model): ModelRef<string> => ({
    key: model.key,
    reasoning: model.reasoning ?? false,
    model: model.key,
  }));
  const byKey = new Map(refs.map((ref) => [ref.key, ref]));
  const sessionKey = session ?? models[0]?.key;
  return {
    calls,
    told,
    host: {
      notices: { kind: "ui", notify: (text) => told.push(text) },
      session: () => byKey.get(sessionKey ?? ""),
      find: (requested) => byKey.get(`${requested.provider}/${requested.id}`),
      async complete(ref, request) {
        calls.push({ model: ref.key, prompt: request.prompt, maxTokens: request.maxTokens });
        const answer = models.find((model) => model.key === ref.key)?.answer ?? "ok";
        return { outcome: "answer", text: answer, stop: "stop", usage: undefined };
      },
    },
  };
}

export type FakeScript = ModelAnswer | Error | ((key: string) => ModelAnswer | Error);

export interface ScriptedHost {
  readonly host: ModelHost<string>;
  readonly calls: { model: string; prompt: string; maxTokens: number }[];
}

export interface ScriptedHostOptions {
  readonly notify?: (text: string, level: "info" | "warning") => void;
  readonly reasoning?: readonly string[];
}

export function scriptedHost(
  scripts: Record<string, FakeScript>,
  sessionKey: string,
  options?: ScriptedHostOptions,
): ScriptedHost {
  const calls: ScriptedHost["calls"] = [];
  const refs = new Map(
    Object.keys(scripts).map((key): [string, ModelRef<string>] => [
      key,
      { key, reasoning: options?.reasoning?.includes(key) ?? false, model: key },
    ]),
  );
  return {
    calls,
    host: {
      notices: options?.notify ? { kind: "ui", notify: options.notify } : { kind: "none" },
      session: () => refs.get(sessionKey),
      find: (requested) => refs.get(`${requested.provider}/${requested.id}`),
      async complete(ref, request) {
        calls.push({ model: ref.key, prompt: request.prompt, maxTokens: request.maxTokens });
        const script = scripts[ref.key];
        if (script === undefined) throw new Error(`scripted host: no script for ${ref.key}`);
        const reply = typeof script === "function" ? script(ref.key) : script;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

export interface FakeReader {
  readonly reader: Reader;
  readonly requests: ReaderRequest[];
  readonly handed: ReaderResult[][];
}

export function fakeReader(script: readonly ReaderReply[]): FakeReader {
  const requests: ReaderRequest[] = [];
  const handed: ReaderResult[][] = [];
  let index = 0;
  return {
    requests,
    handed,
    reader: {
      begin(request) {
        requests.push(request);
        return {
          next(results) {
            handed.push([...results]);
            const reply = script[index];
            index += 1;
            if (!reply) throw new Error("fake reader: script exhausted");
            return Promise.resolve(reply);
          },
        };
      },
    },
  };
}
