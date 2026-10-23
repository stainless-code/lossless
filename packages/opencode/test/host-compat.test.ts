import type { Message } from "@opencode/ai";
import type { Agent, Plugin } from "@opencode/plugin";
import type {
  CommandDefinition as HostCommandDefinition,
  CommandEditor as HostCommandEditor,
} from "@opencode/plugin/promise/command";
import type {
  SessionCompaction as HostSessionCompaction,
  SessionCompactionResult as HostSessionCompactionResult,
  SessionContext as HostSessionContext,
  SessionPrompt as HostSessionPrompt,
} from "@opencode/plugin/promise/session";
import type {
  ToolContext as HostToolContext,
  ToolEditor as HostToolEditor,
} from "@opencode/plugin/promise/tool";
import { describe, expect, it } from "vite-plus/test";

import { statusCommand } from "../src/command.ts";
import type {
  CompactionEvent,
  CompactionMessage,
  CompactionResult,
  ModelCatalog,
  ModelDomain,
  ModelInfo,
  OpencodeContext,
  PermissionRule,
  PromptEvent,
  ReaderSession,
  SessionCompactionEvent,
  SessionContextEvent,
  SessionCreateInput,
  SessionDomain,
  SessionInfo,
  SessionMessageInfo,
  ToolExecuteContext,
} from "../src/host.ts";
import plugin, { setupOpencodeLossless } from "../src/plugin.ts";
import { registerRecallTools } from "../src/tools.ts";

/** The stored-message and model types as the host publishes them. Naming the
 * `@opencode/schema` modules directly would add a dependency this package does
 * not take, so they are read off the context the host does export. */
type HostStoredMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number];
type HostModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number];

/** The package ships no host types (`src/host.ts` is the whole touching
 * surface), so these assertions are the drift guard: each one assigns a real
 * host value to the local shape the runtime actually receives. A host upgrade
 * that changes the surface fails typecheck here instead of packing a silent
 * mismatch. Nothing in this file reaches the bundle. */
describe("host compatibility", () => {
  it("accepts the real plugin context at setup", async () => {
    const host = null as unknown as Plugin.Context;
    const local: OpencodeContext = host;
    const cleanup = await setupOpencodeLossless(local, { enabled: false });
    await cleanup();
    expect(plugin.id).toBe("opencode-lossless");
  });

  it("reads prompts, compactions, and tool contexts through the local shapes", () => {
    const prompt: PromptEvent = null as unknown as HostSessionPrompt;
    const compaction: CompactionEvent = null as unknown as HostSessionCompaction;
    const toolContext: ToolExecuteContext = null as unknown as HostToolContext;
    const role: CompactionMessage["role"] = null as unknown as Message["role"];
    expect([prompt, compaction, toolContext, role]).toHaveLength(4);
  });

  it("registers the recall tools on the real tool editor", () => {
    const editor = null as unknown as HostToolEditor;
    // Typechecked, never run: the call below proves the host editor accepts
    // the local tool table at compile time.
    const register = () =>
      registerRecallTools(editor, { store: () => undefined, redact: (text) => text });
    expect(register).toBeDefined();
    const definition: HostCommandDefinition = statusCommand({
      lines: () => [],
      prompt: () => Promise.resolve(undefined),
    });
    expect(definition.name).toBe("lossless-status");
  });

  it("reads stored history through the real session, message, and model types", () => {
    const context: SessionContextEvent = null as unknown as HostSessionContext;
    const message: SessionMessageInfo = null as unknown as HostStoredMessage;
    const model: ModelInfo = null as unknown as HostModelInfo;
    const session: SessionDomain = null as unknown as Plugin.Context["session"];
    expect([context, message, model, session]).toHaveLength(4);
  });

  it("accepts the host's prepared compaction as the local event", () => {
    // The hook needs the host-to-local direction: the host calls the callback
    // with its own prepared request. A local shape that dropped or mistyped a
    // field would reject that value. `as` would not catch it; this does.
    type Fits<A, B> = A extends B ? true : never;
    const eventFits: Fits<HostSessionCompaction, SessionCompactionEvent> = true;
    const resultFits: Fits<HostSessionCompactionResult, CompactionResult> = true;
    expect([eventFits, resultFits]).toEqual([true, true]);
  });

  it("creates a child session through the real session and agent types", () => {
    // The promise session domain is the only route to a child session, and
    // `SessionCreateInput.permissions` is the only way to narrow the agent.
    type HostSessionInfo = Awaited<ReturnType<Plugin.Context["session"]["create"]>>;
    type HostCreateInput = NonNullable<Parameters<Plugin.Context["session"]["create"]>[0]>;
    const info: SessionInfo = null as unknown as HostSessionInfo;
    const input: SessionCreateInput = null as unknown as HostCreateInput;
    const rules: readonly PermissionRule[] = null as unknown as Agent.Info["permissions"];
    const reader: ReaderSession = null as unknown as Plugin.Context["session"];
    const agentInfo: Agent.Info = null as unknown as Agent.Info;
    // Typechecked, never called: each field below has to exist on the real
    // host type for these probes to compile.
    const idOf = (value: SessionInfo): string => value.id;
    const parentOf = (value: SessionCreateInput) => value.parentID;
    const permissionsOf = (value: SessionCreateInput) => value.permissions;
    const modeOf = (value: Agent.Info) => value.mode;
    const narrow = (value: Plugin.Context["session"]): ReaderSession => value;
    expect([
      info,
      input,
      rules,
      reader,
      agentInfo,
      idOf,
      parentOf,
      permissionsOf,
      modeOf,
      narrow,
    ]).toHaveLength(10);
  });

  it("reads the model catalogue through the real list call", () => {
    const domain: ModelDomain = null as unknown as Plugin.Context["model"];
    const catalogue: ModelCatalog = null as unknown as Awaited<
      ReturnType<Plugin.Context["model"]["list"]>
    >;
    expect([domain, catalogue]).toHaveLength(2);
  });

  it("adds the status command to the real command editor", () => {
    const editor = null as unknown as HostCommandEditor;
    // Typechecked, never run: proves the host editor accepts the command.
    const add = () =>
      editor.add(
        statusCommand({
          lines: () => [],
          prompt: () => Promise.resolve(undefined),
        }),
      );
    expect(add).toBeDefined();
  });
});
