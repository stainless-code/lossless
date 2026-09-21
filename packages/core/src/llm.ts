import { estimateTokens } from "./estimate-tokens.ts";
import type { CompletionRequest, ModelAnswer, ModelHost, ModelRef, Notices } from "./host.ts";
import { appendMetric, summarizerUsageRecord } from "./metrics.ts";
import type { SummarizerFailureCategory, SummarizerOutcome, SummarizerStage } from "./metrics.ts";

export interface SummarizerConfig {
  /** One model id, or an ordered fallback chain. `auto` is the session model. */
  summarizer?: string | string[];
  /** Tokens one request may cost, estimate plus output cap, before it is refused
   * rather than paid for. A backstop, not a throttle. */
  summarizerTokensPerCall?: number;
  /** Tokens one pass may spend across all its calls, counted from what the
   * provider reported. Reaching it finishes the pass mechanically. */
  summarizerTokensPerPass?: number;
}

/**
 * Thinking tokens are charged against the completion budget, so a reasoning
 * model can spend the whole cap before it emits any text. The headroom sits on
 * top of the caller's request, so the requested output size does not change.
 */
export const REASONING_HEADROOM = 4096;

/** `auto` is the session model. It never means "choose one for me". */
const AUTO = "auto";

export interface ResolvedChain<Model> {
  /** The models to try, in order and deduped. Empty when nothing resolves. */
  models: ModelRef<Model>[];
  /** Configured entries the host could not resolve, in order. */
  unresolved: string[];
  requested: string[];
}

function requestedChain(value: string | string[] | undefined): string[] {
  const list = value === undefined ? [AUTO] : Array.isArray(value) ? value : [value];
  const ids = list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return [...new Set(ids)];
}

/** Expand the configured chain: `auto` (the session model) goes last unless the
 * chain names it, so one bad entry still leaves the session able to summarize. */
export function resolveModels<Model>(
  host: ModelHost<Model>,
  config: SummarizerConfig,
): ResolvedChain<Model> {
  const models: ModelRef<Model>[] = [];
  const unresolved: string[] = [];
  const requested = requestedChain(config.summarizer);
  const seen = new Set<string>();
  const push = (ref: ModelRef<Model> | undefined): void => {
    if (!ref || !ref.key || seen.has(ref.key)) return;
    seen.add(ref.key);
    models.push(ref);
  };
  for (const entry of requested) {
    if (entry === AUTO) {
      push(host.session());
      continue;
    }
    const slash = entry.indexOf("/");
    const found =
      slash > 0
        ? host.find({ provider: entry.slice(0, slash), id: entry.slice(slash + 1) })
        : undefined;
    if (found) push(found);
    else unresolved.push(entry);
  }
  push(host.session());
  return { models, unresolved, requested };
}

/** The one rendering of a resolved chain. The level travels with the warning so
 * no caller can pick a different notify level for the same chain. */
export type ChainReport =
  | { level: "info"; state: string }
  | { level: "warning"; state: string; warning: string };

export function describeSummarizerChain<Model>(chain: ResolvedChain<Model>): ChainReport {
  const resolved = chain.models.map((model) => model.key).join(" → ");
  const state = `summarizer: ${resolved || "(no model resolves)"} · config: ${chain.requested.join(", ")}`;
  if (chain.unresolved.length === 0) return { level: "info", state };
  return {
    level: "warning",
    state,
    warning: `summarizer model not found: ${chain.unresolved.join(", ")}; using ${resolved || "(nothing: no model resolves)"}`,
  };
}

/** The span every call from one completer summarizes. The failure cap is per
 * span, so a completer is built with the span it will be asked about. */
export interface SummarizedSpan {
  firstEntryId: string;
  lastEntryId: string;
}

export interface MakeLlmOptions {
  session: string;
  stage?: SummarizerStage;
  span: SummarizedSpan;
}

/** Failed walks in a row before a pass stops calling the model and lets the
 * ladder's deterministic truncate finish the span. One is too eager, because a
 * single transport blip would turn a whole span mechanical; past three, another
 * call carries no new information about the provider and costs its latency. */
export const SUMMARIZER_FAILURE_CAP = 3;

/** What one request may cost before it is refused instead of paid for. It exists
 * for a pathological chunk rather than for a normal one. */
export const SUMMARIZER_CALL_TOKENS = 60_000;

/** What one pass may spend across all of its calls. */
export const SUMMARIZER_PASS_TOKENS = 250_000;

/** The categories a second attempt can fix. A dropped socket or a 5xx is often
 * one request's bad luck; a rate limit needs waiting rather than asking, a key
 * does not change between calls, and the output cap, an empty answer and an
 * unreadable error all reproduce themselves. */
const RETRIABLE: ReadonlySet<SummarizerFailureCategory> = new Set(["unavailable", "timeout"]);

export function retriableCategory(category: SummarizerFailureCategory): boolean {
  return RETRIABLE.has(category);
}

/** How long a span whose calls were capped is left alone. Shorter than the kick
 * backoff (`KICK_BACKOFF_MS`) on purpose: this guards a retry inside one turn,
 * it is not the breaker that stops re-kicks across turns. */
export const FAILED_SPAN_TTL_MS = 60_000;

/** Spans that were capped, by fingerprint, so an identical second pass inside
 * the TTL is not paid for again. Bounded and self-expiring, and keyed by entry
 * ids that only one session has. */
const cappedSpans = new Map<string, { at: number; category: SummarizerFailureCategory }>();
const CAPPED_SPAN_MEMORY = 64;

/** What a failed span is identified by: the two ends a caller asked about and
 * the chain it asked. A different model is a different attempt, not the same
 * failure, so the chain is part of the key. */
export function spanFingerprint(span: SummarizedSpan, chain: readonly string[]): string {
  return `${span.firstEntryId}..${span.lastEntryId}|${chain.join(",")}`;
}

/**
 * A call that reached no usable answer. `category` is what the provider's own
 * text says: a best-effort read that answers `unknown` rather than guessing, and
 * `capped` when the caller should stop asking rather than the provider failing.
 */
export class SummarizerFailure extends Error {
  constructor(
    message: string,
    readonly category: SummarizerFailureCategory,
  ) {
    super(message);
    this.name = "SummarizerFailure";
  }
}

const AUTH = /\b(401|403|unauthoriz|forbidden|invalid api key|api key|authentication)\b/i;
const RATE_LIMIT = /\b(429|rate ?limit|too many requests|quota|overloaded)\b/i;
const UNAVAILABLE =
  /\b(50\d|service unavailable|bad gateway|econnreset|econnrefused|enotfound|socket hang up|model not found|unknown model|does not exist)\b/i;
const TIMEOUT = /\b(timeout|timed out|etimedout|deadline|aborted|abort)\b/i;
const TOKEN_CAP = /\b(token cap|max(imum)? tokens|output limit|length limit)\b/i;

/** Which bucket a provider's error text falls in. A 5xx or a dropped connection
 * is `unavailable` before it is `timeout`, because the gateway's own timeout is
 * a request that never reached a model. */
export function classifyFailure(text: string | undefined): SummarizerFailureCategory {
  if (!text) return "unknown";
  if (AUTH.test(text)) return "auth";
  if (RATE_LIMIT.test(text)) return "rate-limit";
  if (UNAVAILABLE.test(text)) return "unavailable";
  if (TIMEOUT.test(text)) return "timeout";
  if (TOKEN_CAP.test(text)) return "length";
  return "unknown";
}

/** `threw` covers every unusable answer: a rejected call, an error stop, and a
 * length stop. `empty` means the call succeeded and returned no text. */
type SummarizerAttempt =
  | { model: string; outcome: "ok" | "empty" }
  | { model: string; outcome: "threw"; error: string };

export function makeLlm<Model>(
  host: ModelHost<Model>,
  config: SummarizerConfig,
  opts: MakeLlmOptions,
) {
  const { session, stage, span } = opts;
  const resolved = resolveModels(host, config);
  const { models } = resolved;
  if (resolved.unresolved.length > 0) reportUnresolved(host.notices, resolved, session);
  const first = models[0];
  if (!first) return null;
  const fingerprint = spanFingerprint(
    span,
    models.map((model) => model.key),
  );
  let consecutive = 0;
  /** Set once this completer has spent its budget: the rest of the pass is
   * mechanical, which is what bounds one pass whatever the pass's wall clock.
   * The span memory below is what bounds the next one. */
  let stopped = false;
  let stoppedBy: SummarizerFailureCategory = "unknown";
  let spent = 0;
  const callBudget = config.summarizerTokensPerCall ?? SUMMARIZER_CALL_TOKENS;
  const passBudget = config.summarizerTokensPerPass ?? SUMMARIZER_PASS_TOKENS;
  /** The budget's refusal, which is the give-up the failure cap already performs:
   * the ladder's deterministic truncate finishes the span, and the row names the
   * budget that crossed. */
  const refuseBudget = (reason: "call" | "pass", estimate: number): never => {
    if (!reported) {
      reported = true;
      appendMetric({
        event: "lcm",
        kind: "summarizer-capped",
        stage,
        session,
        fingerprint,
        failedWalks: 0,
        category: "capped",
        source: "budget",
        reason,
        spentTokens: spent,
        budgetTokens: reason === "call" ? callBudget : passBudget,
        span: [span.firstEntryId, span.lastEntryId],
      });
    }
    throw new SummarizerFailure(
      `lcm: summarizer budget reached for ${span.firstEntryId}..${span.lastEntryId} (${reason}: ${estimate} tokens against ${reason === "call" ? callBudget : passBudget}); the span is stored as a mechanical truncate`,
      "capped",
    );
  };
  let reported = false;
  const report = (category: SummarizerFailureCategory, paid: number, remembered: boolean): void => {
    if (reported) return;
    reported = true;
    appendMetric({
      event: "lcm",
      kind: "summarizer-capped",
      stage,
      session,
      fingerprint,
      failedWalks: paid,
      category,
      source: remembered ? "span-memory" : "pass",
      span: [span.firstEntryId, span.lastEntryId],
    });
  };
  const refuse = (category: SummarizerFailureCategory, remembered: boolean): never => {
    report(category, 0, remembered);
    throw new SummarizerFailure(
      `lcm: summarizer calls for ${span.firstEntryId}..${span.lastEntryId} stopped (${category}); the span is stored as a mechanical truncate`,
      "capped",
    );
  };

  const order = [...models];
  return async (systemPrompt: string, userText: string, maxTokens: number): Promise<string> => {
    if (stopped) return refuse(stoppedBy, false);
    // The request's own size is known before it is paid for, which is what makes
    // this a cap rather than a report: the prompt, the source, and the output cap
    // the provider is allowed to charge for.
    const estimate =
      estimateTokens(systemPrompt) + estimateTokens(userText) + Math.max(0, maxTokens);
    if (estimate > callBudget) return refuseBudget("call", estimate);
    if (spent + estimate > passBudget) return refuseBudget("pass", estimate);
    const remembered = cappedSpans.get(fingerprint);
    if (remembered && Date.now() - remembered.at < FAILED_SPAN_TTL_MS) {
      // The memory is a fact about the span, so this completer is mechanical
      // for its whole life once it has been refused: a pass that outlives the
      // TTL would otherwise start paying again, and the one-shot cap row is
      // already spent, so that second give-up would leave no record at all.
      stopped = true;
      stoppedBy = remembered.category;
      return refuse(remembered.category, true);
    }
    const attempts: SummarizerAttempt[] = [];
    let failure: SummarizerFailureCategory = "unknown";
    // A slice on purpose: a failure reorders `order` mid-walk, and this call
    // still visits each entry of the state it started with.
    for (const model of order.slice()) {
      const key = model.key;
      let answer: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await host.complete(
            model,
            requestOf(systemPrompt, userText, maxTokens, model),
          );
          // Recorded whether or not the answer is used: a rejected call and a
          // model that is demoted mid-chain were both billed.
          const row = summarizerUsageRecord(result.usage, {
            model: key,
            stage,
            outcome: outcomeOf(result),
            stopReason: result.stop,
            session,
          });
          if (row) appendMetric(row);
          // What the provider reported, which is what the pass budget counts: an
          // estimate got the call refused, and only the report is spend.
          spent += (row?.input ?? 0) + (row?.output ?? 0);
          if (result.outcome === "failed") {
            attempts.push({ model: key, outcome: "threw", error: result.reason });
            failure = result.capped ? "length" : classifyFailure(result.reason);
          } else if (result.text.trim().length > 0) {
            attempts.push({ model: key, outcome: "ok" });
            answer = result.text;
          } else {
            attempts.push({ model: key, outcome: "empty" });
            failure = "empty";
          }
        } catch (error) {
          attempts.push({ model: key, outcome: "threw", error: message(error) });
          failure = classifyFailure(message(error));
        }
        if (answer !== null || !retriableCategory(failure)) break;
      }
      if (answer !== null) {
        consecutive = 0;
        reportFallback(attempts, key, session);
        return answer;
      }
      demote(order, model);
    }
    reportFallback(attempts, null, session);
    consecutive++;
    if (consecutive >= SUMMARIZER_FAILURE_CAP) {
      stopped = true;
      stoppedBy = failure;
      cappedSpans.set(fingerprint, { at: Date.now(), category: failure });
      const oldest = cappedSpans.keys().next().value;
      if (oldest !== undefined && cappedSpans.size > CAPPED_SPAN_MEMORY) cappedSpans.delete(oldest);
      report(failure, consecutive, false);
    }
    // Every model answering with no text is the empty-response signal; only a
    // chain where every call threw is an error. The walk that spent the last
    // of the budget answers like any other, because it was paid for: what the
    // cap row speaks for is the refusals after it.
    if (attempts.some((a) => a.outcome === "empty")) return "";
    const failures = attempts.flatMap((a) =>
      a.outcome === "threw" ? [`${a.model}: ${a.error}`] : [],
    );
    throw new SummarizerFailure(
      `lcm: every summarizer model failed (${failures.join("; ")})`,
      failure,
    );
  };
}

function demote<Model>(order: ModelRef<Model>[], model: ModelRef<Model>): void {
  const at = order.indexOf(model);
  if (at < 0 || at === order.length - 1) return;
  order.splice(at, 1);
  order.push(model);
}

function reportFallback(attempts: SummarizerAttempt[], used: string | null, session: string): void {
  if (attempts.length < 2) return;
  appendMetric({ event: "lcm", kind: "summarizer-fallback", attempts, used, session });
}

/** Report an unresolved entry once per chain per session, in metrics and in the
 * UI: a substitution that only reaches a log file leaves a typo billing every
 * summary at the session model's rate. */
function reportUnresolved<Model>(
  notices: Notices,
  resolved: ResolvedChain<Model>,
  session: string,
): void {
  const report = describeSummarizerChain(resolved);
  if (report.level !== "warning") return;
  const keys = resolved.models.map((model) => model.key);
  const signature = `${resolved.unresolved.join(",")}|${keys.join(",")}|${resolved.requested.join(",")}`;
  if (warned.has(signature)) return;
  warned.add(signature);
  if (notices.kind === "ui") notices.notify(`LCM: ${report.warning}`, report.level);
  appendMetric({
    event: "lcm",
    kind: "summarizer-model",
    requested: resolved.requested,
    chain: keys,
    unresolved: resolved.unresolved,
    session,
  });
}

/** Hook events re-resolve the same broken config; warn once per session. */
const warned = new Set<string>();

/** Sessions share the process, so each one gets to see the config it runs, and
 * a session that starts fresh should not inherit a refusal from the last one. */
export function resetSummarizerState(): void {
  warned.clear();
  cappedSpans.clear();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

function outcomeOf(answer: ModelAnswer): SummarizerOutcome {
  if (answer.outcome === "failed") return "failure";
  return answer.text.trim().length > 0 ? "ok" : "empty";
}

/** One rendered prompt and one output cap. The prompt is joined here, delimiters
 * included, so no host can change what the summarizer is asked. */
function requestOf(
  systemPrompt: string,
  userText: string,
  maxTokens: number,
  model: ModelRef<unknown>,
): CompletionRequest {
  return {
    prompt: `${systemPrompt}\n\n<conversation>\n${userText}\n</conversation>`,
    maxTokens: maxTokens + (model.reasoning ? REASONING_HEADROOM : 0),
  };
}
