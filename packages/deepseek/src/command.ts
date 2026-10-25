import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";

import {
  handleBackup,
  handleDiagnose,
  handleExport,
  handleGc,
  handleHeal,
  handleImport,
  handleMigrate,
  handleReport,
  handleStatus,
  type LcmCommandDeps,
} from "./lifecycle.ts";

export type { LcmCommandDeps } from "./lifecycle.ts";

const USAGE =
  "Usage: /lcm [status|report|backup [file]|export [file]|import <file>|gc [--apply]|migrate [--apply]|heal [--apply] [--max-nodes N]|diagnose [--save <file>]|compact]";

function assertNever(value: never): never {
  throw new Error(`unknown manual compaction error code: ${String(value)}`);
}

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

/** The `/lcm` command: read-only operator verbs, mutating verbs with dry-run
 * defaults, plus one manual compaction. Subcommand routing is manual dispatch
 * inside this one handler: the command registry rejects a second registration
 * under the same name, so `/lcm report` and friends arrive here as raw input. */
export function lcmCommandDefinition(ctx: Context, deps: LcmCommandDeps) {
  return {
    definitionId: CommandDefinitionId("deepseek-lossless"),
    name: "lcm",
    description:
      "Lossless session memory: status, report, backup, export, import, gc, migrate, heal, diagnose, compact",
    handler: (invocation: CommandInvocation): Promise<CommandResult> => {
      const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      const verb = tokens[0] ?? "";
      const args = tokens.slice(1);
      if (verb === "" || verb === "status") return handleStatus(ctx, deps, invocation);
      if (verb === "report") return Promise.resolve(handleReport(deps, invocation));
      if (verb === "backup") return Promise.resolve(handleBackup(deps, invocation, args));
      if (verb === "export") return Promise.resolve(handleExport(deps, invocation, args));
      if (verb === "import") return Promise.resolve(handleImport(deps, invocation, args));
      if (verb === "gc") return Promise.resolve(handleGc(deps, invocation, args));
      if (verb === "migrate") return Promise.resolve(handleMigrate(deps, invocation, args));
      if (verb === "heal") return handleHeal(ctx, deps, invocation, args);
      if (verb === "diagnose") return handleDiagnose(ctx, deps, invocation, args);
      if (verb === "compact") return handleCompact(ctx, invocation);
      return Promise.resolve({ kind: "error", text: USAGE });
    },
  };
}

/** Register `/lcm` on a composition with a commands service. Returns its disposer. */
export function registerLcmCommand(ctx: Context, deps: LcmCommandDeps): () => void {
  return ctx.commands.register(lcmCommandDefinition(ctx, deps));
}
