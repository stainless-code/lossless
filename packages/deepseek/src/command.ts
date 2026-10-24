import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import type { LcmStore } from "lossless-core";

export interface LcmCommandDeps {
  readonly stores: () => ReadonlyMap<string, LcmStore>;
}

const USAGE = "Usage: /lcm [status|compact]";

/** Fail loudly if a locally closed union gains an unhandled member. */
function assertNever(value: never): never {
  throw new Error(`unknown manual compaction error code: ${String(value)}`);
}

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case "busy":
      return {
        kind: "error",
        text: "Compaction is unavailable because this process has an active compaction, or the agent is not idle.",
      };
    case "cancelled":
      return { kind: "error", text: "Compaction cancelled." };
    case "changed":
      return {
        kind: "error",
        text: "The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.",
      };
    case "summary":
      return {
        kind: "error",
        text: "Compaction could not produce a useful summary. The attempt is recorded in the session log.",
      };
    case "commit":
      return {
        kind: "error",
        text: "Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.",
      };
    case "persistence":
      return {
        kind: "error",
        text: "Compaction finished, but the session could not be saved.",
      };
    default:
      return assertNever(error.code);
  }
}

async function handleCompact(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  try {
    const result = await ctx.compaction.compactNow(
      invocation.agent,
      invocation.signal,
      invocation.commandId,
    );
    if (result === null) return { kind: "success", text: "No compactable history yet." };
    return {
      kind: "success",
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    };
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: "error", text: "Compaction cancelled." };
    if (error instanceof ManualCompactionError) return expectedFailure(error);
    throw error;
  }
}

function handleStatus(deps: LcmCommandDeps): CommandResult {
  const stores = deps.stores();
  if (stores.size === 0) return { kind: "success", text: "LCM has mirrored no sessions yet." };
  const lines = [...stores].map(([id, store]) => {
    const messages = store.allMessages().length;
    const summaries = store.allSummaries().length;
    return `${id}: ${messages} messages, ${summaries} summaries`;
  });
  return { kind: "success", text: lines.join("\n") };
}

/** The `/lcm` command: `status` reports the mirror, `compact` forces one
 * manual compaction through whichever backend the composition mounted. */
export function lcmCommandDefinition(ctx: Context, deps: LcmCommandDeps) {
  return {
    definitionId: CommandDefinitionId("deepseek-lossless"),
    name: "lcm",
    description: "Lossless session memory: status and manual compaction",
    handler: (invocation: CommandInvocation): Promise<CommandResult> => {
      const verb = invocation.rawInput.trim().split(/\s+/, 1)[0] ?? "";
      if (verb === "" || verb === "status") return Promise.resolve(handleStatus(deps));
      if (verb === "compact") return handleCompact(ctx, invocation);
      return Promise.resolve({ kind: "error", text: USAGE });
    },
  };
}

/** Register `/lcm` on a composition with a commands service. Returns its disposer. */
export function registerLcmCommand(ctx: Context, deps: LcmCommandDeps): () => void {
  return ctx.commands.register(lcmCommandDefinition(ctx, deps));
}
