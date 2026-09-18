import { query } from "@open-gitagent/gitagent";
import type { GCHooks, GCMessage } from "@open-gitagent/gitagent";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildModelChain } from "./config.js";
import type { BacktestResult, ProviderAttempt } from "./types.js";

const execFileAsync = promisify(execFile);

export class AgentCancelledError extends Error {
  constructor() {
    super("The analyst stopped this run.");
    this.name = "AgentCancelledError";
  }
}

export class AllProvidersFailedError extends Error {
  readonly attempts: ProviderAttempt[];
  constructor(attempts: ProviderAttempt[]) {
    super(
      attempts.length
        ? `Every configured model provider failed (${attempts.length} tried).`
        : "No model provider is configured on this deployment.",
    );
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
  }
}

export interface AgentRunResult {
  text: string;
  commitMsg: string | null;
  backtest: BacktestResult | null;
  /** The agent called `backtest` but the tool itself errored. RULES.md
   *  item 3 wants that stated, not treated as "no backtest". */
  backtestError: string | null;
  providerAttempts: ProviderAttempt[];
  costUsd: number | null;
}

async function currentBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

// Independent, programmatic mirror of agent/hooks/guard-branch.sh. Belt
// and suspenders: this one runs in-process for every SDK call the
// server makes; the shell script covers the case someone runs the
// bare `gitagent` CLI against this directory by hand. Neither should
// ever actually fire in normal use, because the server only ever
// passes a `dir` that's already checked out on a proposal/* branch --
// see repoManager.ts's createProposal.
function buildHooks(worktreeRoot: string): GCHooks {
  return {
    preToolUse: async (ctx) => {
      if (ctx.toolName === "write" || ctx.toolName === "cli") {
        const branch = await currentBranch(worktreeRoot);
        if (branch === "main") {
          return {
            action: "block",
            reason: `programmatic guard: refusing ${ctx.toolName} while checked out on main (see agent/RULES.md #1)`,
          };
        }
      }
      return { action: "allow" };
    },
  };
}

function extractCommitMsg(text: string): { text: string; commitMsg: string | null } {
  const match = text.match(/^\s*COMMIT_MSG:\s*(.+)$/m);
  if (!match) return { text, commitMsg: null };
  const commitMsg = match[1].trim().replace(/^["'`]|["'`]$/g, "");
  const cleaned = text.replace(match[0], "").trimEnd();
  return { text: cleaned, commitMsg };
}

function extractBacktest(messages: GCMessage[]): { backtest: BacktestResult | null; error: string | null } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== "tool_result" || m.toolName !== "backtest") continue;
    if (m.isError) return { backtest: null, error: m.content.slice(0, 400) };
    try {
      const parsed = JSON.parse(m.content) as BacktestResult & { error?: string };
      // The tool reports its own refusals as {"error": "..."} on stdout
      // with a non-zero exit; that's a failed backtest, not a result.
      if (parsed.error) return { backtest: null, error: String(parsed.error).slice(0, 400) };
      if (!parsed.current || !parsed.candidate) {
        return { backtest: null, error: "backtest returned a result with no current/candidate scores" };
      }
      return { backtest: parsed, error: null };
    } catch {
      return { backtest: null, error: "backtest returned output that was not valid JSON" };
    }
  }
  return { backtest: null, error: null };
}

/**
 * Runs one agent turn against `agentDir` (already checked out on a
 * proposal/* branch worktree), trying each configured model in order
 * until one produces a real answer. Every attempt -- success or
 * failure -- is recorded in `providerAttempts` and returned to the
 * caller, so "Groq is out of credits, fell back to Llama 3.1 8B" is
 * something the analyst can actually see in the workbench rather than
 * a swallowed retry.
 */
export async function runAgentTurn(opts: {
  agentDir: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  const chain = buildModelChain();
  const providerAttempts: ProviderAttempt[] = [];

  if (chain.length === 0) throw new AllProvidersFailedError(providerAttempts);
  if (opts.signal?.aborted) throw new AgentCancelledError();

  const worktreeRoot = path.resolve(opts.agentDir, "..");

  for (const candidate of chain) {
    if (opts.signal?.aborted) throw new AgentCancelledError();
    const startedAt = Date.now();
    try {
      const messages: GCMessage[] = [];
      const abortController = new AbortController();
      const forward = () => abortController.abort();
      opts.signal?.addEventListener("abort", forward, { once: true });

      const q = query({
        prompt: opts.prompt,
        dir: opts.agentDir,
        model: candidate.model,
        allowedTools: ["read", "write", "memory", "backtest"],
        hooks: buildHooks(worktreeRoot),
        maxTurns: 8,
        abortController,
        constraints: { temperature: 0.2, maxTokens: 2048 },
      });

      let finalText = "";
      let sawHardError = false;
      let errorDetail = "";
      let resolvedModel: string | undefined;
      let costUsd: number | null = null;

      try {
        for await (const msg of q) {
          messages.push(msg);
          if (msg.type === "assistant") {
            if (msg.content.trim()) finalText = msg.content;
            resolvedModel = msg.model ? `${msg.provider ?? ""}${msg.provider ? ":" : ""}${msg.model}` : resolvedModel;
            if (typeof msg.usage?.costUsd === "number") costUsd = (costUsd ?? 0) + msg.usage.costUsd;
            if (msg.stopReason === "error") {
              sawHardError = true;
              errorDetail = msg.errorMessage ?? "assistant stopReason=error";
            }
            if (msg.stopReason === "aborted") throw new AgentCancelledError();
          }
          if (msg.type === "system" && msg.subtype === "error") {
            sawHardError = true;
            errorDetail = msg.content;
          }
        }
      } finally {
        opts.signal?.removeEventListener("abort", forward);
      }

      if (opts.signal?.aborted) throw new AgentCancelledError();

      if (sawHardError || !finalText.trim()) {
        providerAttempts.push({
          model: candidate.model,
          label: candidate.label,
          ok: false,
          error: errorDetail || "the model returned an empty response",
          ms: Date.now() - startedAt,
        });
        continue;
      }

      providerAttempts.push({
        model: candidate.model,
        label: candidate.label,
        ok: true,
        resolvedModel,
        ms: Date.now() - startedAt,
      });
      const { text, commitMsg } = extractCommitMsg(finalText);
      const { backtest, error: backtestError } = extractBacktest(messages);
      return { text, commitMsg, backtest, backtestError, providerAttempts, costUsd };
    } catch (err) {
      if (err instanceof AgentCancelledError || opts.signal?.aborted) throw new AgentCancelledError();
      providerAttempts.push({
        model: candidate.model,
        label: candidate.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - startedAt,
      });
      continue;
    }
  }

  throw new AllProvidersFailedError(providerAttempts);
}
