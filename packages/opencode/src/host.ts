/** The part of the OpenCode v2 plugin API this package uses, written
 * as local structural types. The published bundle and its declarations name
 * no host SDK: every host value arrives through these shapes, and
 * `test/host-compat.test.ts` pins each one against the real host types, so a
 * host upgrade that changes the API fails typecheck instead of packing a
 * silent mismatch. */

/** A host registration whose disposal releases the hook or transform. */
export interface Registration {
  dispose(): Promise<void>;
}

/** One file attached to a user prompt. The host resolves the uri before the
 * model sees it; the mirror stores the name so the row says what was attached. */
export interface PromptAttachment {
  readonly uri: string;
  readonly name?: string;
}

/** The user-authored prompt a session receives. */
export interface PromptInput {
  readonly text: string;
  readonly files?: readonly PromptAttachment[];
}

/** The `session.prompt` hook payload: which session got the prompt, the
 * message id it is stored under, and the prompt itself. */
export interface PromptEvent {
  readonly sessionID: string;
  readonly messageID: string;
  readonly prompt: PromptInput;
}

/** One message in a prepared compaction request, reduced to its role and
 * content so the mirror can describe the boundary without copying the text. */
export interface CompactionMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly unknown[];
}

/** The compaction boundary as the mirror consumes it: the message set about to
 * be summarized. The host's prepared request satisfies it structurally. */
export interface CompactionEvent {
  readonly sessionID: string;
  readonly messages: readonly unknown[];
}

/** What a compaction hook may return in place of the host's own summary.
 * `native` stays absent: a DAG checkpoint is summary text, not a provider
 * replacement window. `tokens` stays absent unless exact usage is known. */
export interface CompactionResult {
  readonly summary: string;
  readonly native?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly tokens?: unknown;
}

/** The `tool.execute.after` hook payload: the tool, its input, and its result
 * or error. `messageID` and `id` are host identifiers the mirror only reads. */
export interface ToolAfterPayload {
  readonly tool: string;
  readonly sessionID: string;
  readonly messageID: unknown;
  readonly id: unknown;
  readonly input: unknown;
  readonly status: "completed" | "error";
  readonly result?: unknown;
  readonly error?: unknown;
}

/** The host's `Model.Ref` subset: which provider and model, and the optional
 * variant spelling the same model under different settings. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** One stored session message, reduced to the fields the adapter reads. The
 * host keeps every message in one table, so the type is a tag plus the arm's
 * payload: `text` for user, synthetic, and system messages, `content` for an
 * assistant message, `summary` for a compaction, and `metadata` for the marker
 * a compaction hook wrote. `model` is the one a switch, a compaction, or an
 * assistant message names, and `tokens` is the assistant arm's usage record,
 * read for the input the request paid for. */
export interface SessionMessageInfo {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly files?: readonly unknown[];
  readonly content?: readonly unknown[];
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
  readonly status?: string;
  readonly model?: ModelRef;
  readonly tokens?: unknown;
}

/** The stored history of one session, in the host's own order. */
export interface SessionContextApi {
  context(input: { readonly sessionID: string }): Promise<readonly SessionMessageInfo[]>;
}

/** One rule in a session's permission ruleset. The host appends a session's
 * rules after the agent's own, and the last match wins, so a session that
 * opens with deny-all and then names the tools it allows leaves only those. */
export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

/** The fields a child session is created with. The parent link is what keeps
 * the child out of the parent's own history, and `permissions` is the only way
 * to narrow an existing agent, because the agent editor has no add. */
export interface SessionCreateInput {
  readonly parentID?: string | null;
  readonly title?: string | null;
  readonly agent?: string | null;
  readonly permissions?: readonly PermissionRule[] | null;
  readonly model?: ModelRef | null;
}

/** The created session, reduced to the identity the reader records. */
export interface SessionInfo {
  readonly id: string;
  readonly parentID?: string;
}

/** The session calls a child reader needs: create it, run it to idle, read its
 * stored messages, stop it, and delete it. */
export interface ReaderSession {
  context(input: { readonly sessionID: string }): Promise<readonly SessionMessageInfo[]>;
  create(input: SessionCreateInput): Promise<SessionInfo>;
  prompt(args: { readonly sessionID: string; readonly text: string }): Promise<unknown>;
  wait(input: { readonly sessionID: string }): Promise<void>;
  interrupt(input: { readonly sessionID: string }): Promise<{ readonly interrupted: boolean }>;
  remove(input: { readonly sessionID: string }): Promise<void>;
}

export interface SessionDomain extends SessionContextApi {
  hook(name: "prompt", callback: (event: PromptEvent) => void): Promise<Registration>;
  /** The prepared compaction request. A callback that sets `result` skips the
   * host's summarizer; the host stores both the summary and the metadata. */
  hook(
    name: "compaction",
    callback: (event: SessionCompactionEvent) => Promise<void> | void,
  ): Promise<Registration>;
  /** The host calls this with the draft it is about to send. Mutating the draft
   * is how a projection reaches the model; the return value is ignored. */
  hook(
    name: "context",
    callback: (event: SessionContextEvent) => Promise<void> | void,
  ): Promise<Registration>;
  prompt(args: { readonly sessionID: string; readonly text: string }): Promise<unknown>;
  create(input: SessionCreateInput): Promise<SessionInfo>;
  wait(input: { readonly sessionID: string }): Promise<void>;
  interrupt(input: { readonly sessionID: string }): Promise<{ readonly interrupted: boolean }>;
  remove(input: { readonly sessionID: string }): Promise<void>;
}

/** The calling session a tool executes in. */
export interface ToolExecuteContext {
  readonly sessionID: string;
}

export interface RecallToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input: { readonly [key: string]: unknown };
  /** Host tool options. `codemode: false` keeps the tool in the direct tool
   * list instead of behind the `execute` wrapper, which is the only way a
   * session that denies `execute` can still see it. */
  readonly options?: { readonly codemode?: boolean };
  execute(input: unknown, context: ToolExecuteContext): Promise<{ readonly content: string }>;
}

/** The host's tool registration editor: a transform adds definitions here. */
export interface ToolEditor {
  add(tool: RecallToolDefinition): void;
}

/** The host's tool domain: one hook after every tool call, and one transform
 * that registers the recall tools. */
export interface ToolDomain {
  hook(name: "execute.after", callback: (event: ToolAfterPayload) => void): Promise<Registration>;
  transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
}

/** What a slash command receives: the session it runs in and the prompt it
 * should hand back to the loop. */
export interface CommandInvocation {
  readonly sessionID: string;
  readonly prompt: PromptInput;
  readonly delivery: unknown;
}

/** One slash command the adapter registers. */
export interface CommandDefinition {
  readonly name: string;
  readonly description?: string;
  execute(input: CommandInvocation): Promise<void>;
}

/** The host's command registration editor. */
export interface CommandEditor {
  add(command: CommandDefinition): void;
}

/** The host's command domain: a transform that adds commands. */
export interface CommandDomain {
  transform(callback: (editor: CommandEditor) => void): Promise<Registration>;
}

/** The host's event bus. The adapter subscribes once and pumps the durable
 * events it mirrors; the iterator ends when the server stops. */
export interface EventDomain {
  subscribe(): AsyncIterable<unknown>;
}

/** What a generation hook receives for one model request. The host builds it
 * from the session's own messages, so the adapter can read the same history
 * the model is about to see. `messages` and `system` are the live draft the
 * host sends, which is why they are mutable here: a projection splices
 * `messages` in place, and a reader child replaces `system` with its own
 * instructions. */
export interface SessionContextEvent {
  readonly sessionID: string;
  readonly model: ModelRef;
  system: unknown[];
  messages: unknown[];
  readonly options: Record<string, unknown>;
  readonly agent: string;
  readonly tools: Record<string, { readonly description: string; readonly input: unknown }>;
}

/** The same prepared request the compaction hook sees, plus the one mutable
 * slot: setting `result` replaces the summary the host would have generated and
 * skips the model call. */
export interface SessionCompactionEvent extends SessionContextEvent {
  result?: CompactionResult;
}

/** One model in the host's catalogue, reduced to what a summarizer chain
 * needs: how to name it and how large a context it accepts. */
export interface ModelInfo {
  readonly providerID: string;
  readonly id: string;
  readonly limit: { readonly context: number; readonly output?: number };
  readonly cost?: unknown;
}

/** The host's own text-only generation call. It selects the model and caps the
 * answer itself; there is no place to send the core's `maxTokens` request and
 * no usage to read back. */
export interface GenerateText {
  text(input: {
    readonly prompt: string;
    readonly model?: ModelRef;
  }): Promise<{ readonly text: string }>;
}

/** The host's model catalogue as the promise plugin exposes it. */
export interface ModelCatalog {
  readonly data: readonly ModelInfo[];
}

/** The host's model catalogue. `list` is the async route the promise plugin
 * exposes. `get` is the synchronous lookup the host's model editor offers, and
 * the promise context does not, so it stays optional and `find` resolves only
 * where the host supplies it. */
export interface ModelDomain {
  get?(providerID: string, modelID: string): ModelInfo | undefined;
  list(input?: unknown): Promise<ModelCatalog>;
}

/** The plugin context subset `setupOpencodeLossless` runs against. */
export interface OpencodeContext {
  readonly options?: unknown;
  readonly session: SessionDomain;
  readonly tool: ToolDomain;
  readonly command: CommandDomain;
  readonly event: EventDomain;
  readonly generate?: GenerateText;
  readonly model?: ModelDomain;
}
