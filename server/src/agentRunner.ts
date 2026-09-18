import { query } from "@open-gitagent/gitagent";
import type { GCHooks, GCMessage } from "@open-gitagent/gitagent";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildModelChain } from "./config.js";
import type { BacktestResult, ProviderAttempt } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AgentRunResult {
  text: string;
  commitMsg: string | null;
  backtest: BacktestResult | null;
  providerAttempts: ProviderAttempt[];
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
  const match = text.match(/^COMMIT_MSG:\s*(.+)$/m);
  if (!match) return { text, commitMsg: null };
  const commitMsg = match[1].trim();
  const cleaned = text.replace(match[0], "").trimEnd();
  return { text: cleaned, commitMsg };
}

function extractBacktest(messages: GCMessage[]): BacktestResult | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "tool_result" && m.toolName === "backtest" && !m.isError) {
      try {
        return JSON.parse(m.content) as BacktestResult;
      } catch {
        return null;
      }
    }
  }
  return null;
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
export async function runAgentTurn(opts: { agentDir: string; prompt: string }): Promise<AgentRunResult> {
  const chain = buildModelChain();
  const providerAttempts: ProviderAttempt[] = [];

  if (chain.length === 0) {
    return {
      text: "No model provider is configured on this deployment (missing GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).",
      commitMsg: null,
      backtest: null,
      providerAttempts,
    };
  }

  const worktreeRoot = path.resolve(opts.agentDir, "..");

  for (const candidate of chain) {
    try {
      const messages: GCMessage[] = [];
      const q = query({
        prompt: opts.prompt,
        dir: opts.agentDir,
        model: candidate.model,
        allowedTools: ["read", "write", "memory", "backtest"],
        hooks: buildHooks(worktreeRoot),
        maxTurns: 8,
        constraints: { temperature: 0.2, maxTokens: 2048 },
      });

      let finalText = "";
      let sawHardError = false;
      let errorDetail = "";

      for await (const msg of q) {
        messages.push(msg);
        if (msg.type === "assistant") {
          finalText = msg.content;
          if (msg.stopReason === "error") {
            sawHardError = true;
            errorDetail = msg.errorMessage ?? "assistant stopReason=error";
          }
        }
        if (msg.type === "system" && msg.subtype === "error") {
          sawHardError = true;
          errorDetail = msg.content;
        }
      }

      if (sawHardError || !finalText.trim()) {
        providerAttempts.push({
          model: candidate.model,
          label: candidate.label,
          ok: false,
          error: errorDetail || "empty response",
        });
        continue;
      }

      providerAttempts.push({ model: candidate.model, label: candidate.label, ok: true });
      const { text, commitMsg } = extractCommitMsg(finalText);
      const backtest = extractBacktest(messages);
      return { text, commitMsg, backtest, providerAttempts };
    } catch (err) {
      providerAttempts.push({
        model: candidate.model,
        label: candidate.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  return {
    text: "Every configured model provider failed. Check providerAttempts below -- this usually means an API key is invalid, rate-limited, or out of credits.",
    commitMsg: null,
    backtest: null,
    providerAttempts,
  };
}
