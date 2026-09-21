import type { TSchema } from "typebox";

/** What one call was billed, in numbers, so a pass can sum its spend.
 * `UsageLike` in `metrics.ts` is the tolerant reader of the same facts at the
 * metrics boundary, and a `Usage` satisfies it. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A subset of `cacheWrite`, reported by hosts that split retention. */
  cacheWrite1h?: number;
  /** A subset of `output`, reported by hosts that expose the breakdown. */
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** How core tells the operator something. A host with no UI is `none` rather
 * than a dropped callback, so a caller has one branch and no optional to miss. */
export type Notices =
  | { readonly kind: "none" }
  | { readonly kind: "ui"; notify(text: string, level: "info" | "warning"): void };

/** One model the host can call. `key` is the spelling config zones and metric
 * rows already use; `model` is the host's own handle, opaque here. */
export interface ModelRef<Model> {
  readonly key: string;
  readonly reasoning: boolean;
  readonly model: Model;
}

export interface ModelRequest {
  readonly provider: string;
  readonly id: string;
}

export interface CompletionRequest {
  readonly prompt: string;
  readonly maxTokens: number;
}

/** What a call came back with. `stop` is the host's own word, kept verbatim for
 * metric rows; `capped` is the host saying the answer was cut short, which is
 * the one thing a caller must never store. */
export type ModelAnswer =
  | { outcome: "answer"; text: string; stop: string; usage: Usage | undefined }
  | {
      outcome: "failed";
      reason: string;
      capped: boolean;
      stop: string;
      usage: Usage | undefined;
    };

export interface ModelHost<Model> {
  readonly notices: Notices;
  session(): ModelRef<Model> | undefined;
  find(requested: ModelRequest): ModelRef<Model> | undefined;
  complete(model: ModelRef<Model>, request: CompletionRequest): Promise<ModelAnswer>;
}

/** A tool the reader may call. The schema is the host's, passed through rather
 * than rebuilt. */
export interface ReaderTool {
  name: string;
  description: string;
  parameters: TSchema;
}

export interface ReaderCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ReaderResult {
  readonly call: ReaderCall;
  readonly text: string;
}

/** What one reader step produced. `reads` asks the caller to run the calls;
 * `answered` means the reader is done, with whatever text it accumulated. */
export type ReaderReply =
  | { outcome: "reads"; calls: readonly ReaderCall[]; text: string; usage: Usage | undefined }
  | { outcome: "answered"; text: string; usage: Usage | undefined }
  | { outcome: "failed"; reason: string; usage: Usage | undefined };

export interface ReaderRequest {
  readonly systemPrompt: string;
  readonly brief: string;
  readonly tools: readonly ReaderTool[];
}

/** One reader conversation. The host owns the transcript: `next` appends the
 * results it is handed, appends its own reply, and calls the model. */
export interface Reading {
  next(results: readonly ReaderResult[]): Promise<ReaderReply>;
}

export interface Reader {
  begin(request: ReaderRequest): Reading;
}
