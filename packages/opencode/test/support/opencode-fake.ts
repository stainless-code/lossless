import type {
  CommandDefinition,
  CommandEditor,
  GenerateText,
  ModelDomain,
  OpencodeContext,
  PromptEvent,
  RecallToolDefinition,
  Registration,
  SessionCompactionEvent,
  SessionContextEvent,
  SessionCreateInput,
  SessionDomain,
  SessionMessageInfo,
  ToolAfterPayload,
  ToolEditor,
} from "../../src/host.ts";

/** An OpencodeContext double that captures every registration instead of
 * running a server. Hook callbacks stay callable, so tests drive the mirror
 * the way the host would. The `never` parameters keep the captured tool and
 * command tables assignable in both directions at zero runtime cost. */
export interface FakeHost {
  readonly ctx: OpencodeContext;
  readonly sessionHooks: {
    prompt?: (event: PromptEvent) => void;
    compaction?: (event: SessionCompactionEvent) => Promise<void> | void;
    context?: (event: SessionContextEvent) => Promise<void> | void;
  };
  readonly toolHooks: {
    "execute.after"?: (event: ToolAfterPayload) => void;
  };
  readonly tools: Array<{
    readonly name: string;
    readonly options?: { readonly codemode?: boolean };
    readonly execute: (input: never, context: never) => Promise<unknown>;
  }>;
  readonly commands: Array<{
    readonly name: string;
    readonly execute: (input: never) => Promise<void>;
  }>;
  readonly events: FakeEventStream;
  readonly prompts: unknown[];
  /** Every child session the plugin asked the host to create. */
  readonly children: SessionCreateInput[];
  readonly disposals: string[];
  readonly options: Record<string, unknown>;
  /** What `session.context` answers, so a test can drive a pass from history. */
  readonly history: SessionMessageInfo[];
}

export class FakeEventStream {
  private readonly queue: unknown[] = [];
  private notify: (() => void) | undefined;
  private closed = false;

  push(event: unknown): void {
    this.queue.push(event);
    this.notify?.();
    this.notify = undefined;
  }

  [Symbol.asyncIterator] = (): AsyncIterator<unknown> => {
    return {
      next: (): Promise<IteratorResult<unknown>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.notify = () => {
            this.notify = undefined;
            if (this.queue.length > 0) resolve({ value: this.queue.shift(), done: false });
            else resolve({ value: undefined, done: true });
          };
        });
      },
      return: (): Promise<IteratorResult<unknown>> => {
        this.closed = true;
        this.notify?.();
        this.notify = undefined;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  };
}

function registration(host: FakeHost, label: string): { dispose: () => Promise<void> } {
  return {
    dispose: () => {
      host.disposals.push(label);
      return Promise.resolve();
    },
  };
}

function makeSession(
  host: FakeHost,
  tables: FakeHost["sessionHooks"],
  prompts: unknown[],
  children: SessionCreateInput[],
  history: SessionMessageInfo[],
  extras: FakeExtras,
): SessionDomain {
  function hook(name: "prompt", callback: (event: PromptEvent) => void): Promise<Registration>;
  function hook(
    name: "compaction",
    callback: (event: SessionCompactionEvent) => Promise<void> | void,
  ): Promise<Registration>;
  function hook(
    name: "context",
    callback: (event: SessionContextEvent) => Promise<void> | void,
  ): Promise<Registration>;
  function hook(
    name: "prompt" | "compaction" | "context",
    callback: (
      event: PromptEvent & SessionCompactionEvent & SessionContextEvent,
    ) => void | Promise<void>,
  ): Promise<Registration> {
    // Cast after validation: overload dispatch on `name` is the check. Each
    // registration arrived through its own overload, so the joined
    // implementation signature is narrowed back to the arm the tests invoke.
    if (name === "prompt") tables.prompt = callback as (event: PromptEvent) => void;
    else if (name === "compaction") {
      tables.compaction = callback as (event: SessionCompactionEvent) => Promise<void> | void;
    } else {
      tables.context = callback as (event: SessionContextEvent) => Promise<void> | void;
    }
    return Promise.resolve(registration(host, `session:${name}`));
  }
  const session: SessionDomain = {
    hook,
    context: (): Promise<readonly SessionMessageInfo[]> => Promise.resolve(history),
    prompt(args: { readonly sessionID: string; readonly text: string }): Promise<unknown> {
      prompts.push(args);
      return Promise.resolve({ messageID: "msg_test" });
    },
    // A test that never opens a child keeps the no-op defaults; a reader test
    // scripts these through `extras.session`.
    create: (input) => {
      children.push(input);
      return Promise.resolve({
        id: "ses_child",
        ...(typeof input.parentID === "string" ? { parentID: input.parentID } : {}),
      });
    },
    wait: () => Promise.resolve(),
    interrupt: () => Promise.resolve({ interrupted: true }),
    remove: () => Promise.resolve(),
  };
  return { ...session, ...extras.session };
}

/** Host pieces a test supplies beyond the plugin options: the scripted model
 * call and catalogue, and the stored history `session.context` answers with. */
export interface FakeExtras {
  readonly generate?: GenerateText;
  readonly model?: ModelDomain;
  readonly history?: SessionMessageInfo[];
  /** Session calls a test scripts: a reader test owns create, wait, and the
   * child's stored messages. */
  readonly session?: Partial<SessionDomain>;
}

export function fakeHost(options: Record<string, unknown> = {}, extras: FakeExtras = {}): FakeHost {
  const events = new FakeEventStream();
  const host = {} as FakeHost;
  const tools: FakeHost["tools"] = [];
  const commands: FakeHost["commands"] = [];
  const prompts: unknown[] = [];
  const children: SessionCreateInput[] = [];
  const disposals: string[] = [];
  const sessionHooks: FakeHost["sessionHooks"] = {};
  const toolHooks: FakeHost["toolHooks"] = {};
  const history: SessionMessageInfo[] = [...(extras.history ?? [])];
  const ctx: OpencodeContext = {
    options,
    session: makeSession(host, sessionHooks, prompts, children, history, extras),
    ...(extras.generate === undefined ? {} : { generate: extras.generate }),
    ...(extras.model === undefined ? {} : { model: extras.model }),
    tool: {
      hook(
        name: "execute.after",
        callback: (event: ToolAfterPayload) => void,
      ): Promise<Registration> {
        toolHooks["execute.after"] = callback;
        return Promise.resolve(registration(host, `tool:${name}`));
      },
      transform: (callback: (editor: ToolEditor) => void) => {
        callback({
          add: (tool: RecallToolDefinition) => {
            tools.push(tool);
          },
        });
        return Promise.resolve(registration(host, "tool:transform"));
      },
    },
    command: {
      transform: (callback: (editor: CommandEditor) => void) => {
        callback({
          add: (command: CommandDefinition) => {
            commands.push(command);
          },
        });
        return Promise.resolve(registration(host, "command:transform"));
      },
    },
    event: {
      subscribe: () => events,
    },
  };
  Object.assign(host, {
    ctx,
    sessionHooks,
    toolHooks,
    tools,
    commands,
    events,
    prompts,
    children,
    disposals,
    options,
    history,
  });
  return host;
}

/** Let the background event pump run one macrotask. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
