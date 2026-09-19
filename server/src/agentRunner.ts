import { loadAgent, query } from "@open-gitagent/gitagent";
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

/**
 * Groq's 429 carries the wait in its message: "Please try again in
 * 26.2725s". Falling straight down the chain on a rate limit is the
 * wrong move — the TPM budget is per *organisation*, so the next model
 * is just as rate-limited as the one that failed. Waiting the stated
 * interval and retrying the same model is what actually works.
 */
function retryAfterMs(error: string): number | null {
  const m = error.match(/try again in ([\d.]+)\s*s/i);
  if (!m) return null;
  const ms = Math.ceil(Number(m[1]) * 1000);
  // Only worth holding the run open for a short wait.
  return Number.isFinite(ms) && ms > 0 && ms <= 45_000 ? ms + 500 : null;
}

function isRateLimit(error: string): boolean {
  return /\b429\b|rate limit/i.test(error);
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

/**
 * The tools this deployment grants the agent.
 *
 * `cli` is deliberately absent. The product's central claim is that the
 * agent cannot reach `main`, and a shell inside the worktree is a way
 * to reach it — `git update-ref refs/heads/main <sha>` moves the branch
 * even while it is checked out elsewhere, and a single `cli` call can
 * do that before the branch guard gets to look again. `skill_learner`
 * is absent for a narrower reason: crystallizing a skill writes
 * `skills/<name>/SKILL.md` **and runs its own git commit**, which would
 * put commits on the proposal branch outside the server's control and
 * squash-merge them into main on approval.
 */
const PERMITTED_TOOLS = ["read", "write", "edit", "memory", "backtest"];

/**
 * Tools the SDK builds in but this deployment does not grant. These are
 * the ones whose names have to be scrubbed from the system prompt, not
 * just filtered out of the request.
 */
const WITHHELD_TOOLS = ["cli", "task_tracker", "skill_learner", "capture_photo", "agent-browser"];

/**
 * Tools no one advertised and the model invented anyway. The gpt-oss
 * family is trained with a browser/search/python harness, and reaches
 * for it unprompted: GPT-OSS 20B killed a whole run with "attempted to
 * call tool 'search' which was not in request.tools". A hallucinated
 * tool call fails the entire request at the provider, so naming the
 * usual suspects as explicitly unavailable is cheaper than losing the
 * turn to one.
 */
const COMMONLY_HALLUCINATED = ["search", "browser", "web_search", "python", "bash", "shell"];

/**
 * Removes the SDK's references to tools it isn't being given.
 *
 * This is the fix for the bug that made every proposal fail. The SDK
 * assembles a system prompt that unconditionally instructs the model to
 * "FIRST: Call `task_tracker` action begin ... Do NOT skip step 1", and
 * separately filters the tool array by `allowedTools` *after* that
 * prompt is built. So the model was told a tool existed, obediently
 * called it, and the provider rejected the whole request:
 *
 *   Tool call validation failed: attempted to call tool 'task_tracker'
 *   which was not in request.tools
 *
 * Provider-independent, and fatal — the chain doesn't help, because
 * every model in it reads the same contradictory prompt.
 *
 * The fix is to make the advertised set and the permitted set the same
 * set. Rather than granting the tools (see PERMITTED_TOOLS for why we
 * don't want two of them), this drops the prompt sections and sentences
 * that advertise them, then checks its own work: anything still named
 * after the scrub gets an explicit denial appended, so a reworded SDK
 * release degrades into a redundant sentence instead of a dead agent.
 */
export function sanitizeSystemPrompt(prompt: string): { prompt: string; leaked: string[] } {
  const named = new RegExp("`(" + WITHHELD_TOOLS.join("|") + ")`|\\b(" + WITHHELD_TOOLS.join("|") + ")\\s+tool\\b");

  // Whole top-level sections that either drive withheld tools or
  // describe a deployment this isn't. They also cost real money: the
  // Groq free tier allows 8000 tokens per minute across the whole
  // organisation, and a turn that exceeds it is rejected outright with
  // a 413 rather than queued, so every block that doesn't earn its
  // place is a block that can push a proposal over the edge.
  //
  //  - Task Learning & Skill Discovery: drives task_tracker and
  //    skill_learner, neither of which is granted here.
  //  - Workspace Directory: tells the agent where to write generated
  //    artifacts and how to behave on voice, Telegram and WhatsApp.
  //    This agent edits one YAML file and talks to one web UI.
  //  - Memory: the SDK's generic version, which also casts the agent as
  //    "newly awakened — curious and eager to understand the person
  //    you're talking to". SOUL.md and DUTIES.md already say who this
  //    agent is, considerably more precisely, and they contradict it.
  const DROP_SECTIONS = /^#\s*(Task Learning & Skill Discovery|Workspace Directory|Memory)\b/i;
  const sections = prompt.split(/\n(?=# )/);
  const kept = sections.filter((section) => !DROP_SECTIONS.test(section.trim()));

  // Then sentence-level, so the Memory section keeps its first half
  // ("use the `memory` tool") and loses only its second ("you can also
  // use the `cli` tool to run git commands").
  const scrubbed = kept.map((section) =>
    section
      .split("\n")
      .map((line) => {
        if (!named.test(line)) return line;
        const sentences = line.split(/(?<=[.!?])\s+/).filter((sentence) => !named.test(sentence));
        return sentences.join(" ").trim();
      })
      // A scrubbed-away line can leave its own continuation behind — the
      // skills block's "...you MUST load / the top match immediately
      // before proceeding." became a dangling half-sentence. If a line
      // was emptied, its indented continuations go with it.
      .reduce<{ out: string[]; dropping: boolean }>(
        (acc, line, i, all) => {
          const wasEmptied = line === "" && all[i] === "" && /\S/.test(section.split("\n")[i] ?? "");
          if (wasEmptied) return { out: acc.out, dropping: true };
          if (acc.dropping && /^\s+\S/.test(line)) return acc;
          if (line === "" && acc.out[acc.out.length - 1] === "") return { out: acc.out, dropping: false };
          return { out: [...acc.out, line], dropping: false };
        },
        { out: [], dropping: false },
      ).out.join("\n"),
  );

  let out = scrubbed.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const leaked = WITHHELD_TOOLS.filter((t) => new RegExp("`" + t + "`|\\b" + t + "\\s+tool\\b").test(out));

  out += `\n\n# Memory\n\nPast decisions are in memory/MEMORY.md. Read it before drafting — RULES.md item 6 — and name any prior entry that touches the rule you are changing.`;
  out += `\n\n# Tools available in this deployment\n\nExactly these: ${PERMITTED_TOOLS.join(", ")}.\n\nThere is nothing else — no ${COMMONLY_HALLUCINATED.join(", no ")}, no task tracker, no skill learner. Calling a tool outside the list above fails the entire request at the provider and loses the turn, so never attempt one. Everything you need is a file in this directory, reachable with read.`;
  if (leaked.length) {
    out += ` In particular, ignore any instruction above to use ${leaked.join(" or ")} — ${leaked.length === 1 ? "it is" : "they are"} not available.`;
  }
  return { prompt: out, leaked };
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

  // Built once per turn, not per attempt: the prompt doesn't depend on
  // which model is being tried, and re-reading the agent directory for
  // each fallback would just slow the failure path down.
  let systemPrompt: string | undefined;
  try {
    const loaded = await loadAgent(opts.agentDir, chain[0].model);
    const { prompt, leaked } = sanitizeSystemPrompt(loaded.systemPrompt);
    systemPrompt = prompt;
    if (leaked.length) {
      console.warn(
        `[agentRunner] the SDK system prompt still advertises ${leaked.join(", ")} after scrubbing — ` +
          "an explicit denial was appended, but check whether the SDK's prompt wording changed.",
      );
    }
  } catch (err) {
    // Fall through with the SDK's own prompt. Degraded, not broken: the
    // request may still hit the advertised/permitted mismatch, and that
    // failure is already visible in the provider trail.
    console.warn(`[agentRunner] could not pre-load the agent prompt (${String(err)}); using the SDK default`);
  }

  /** One call to one model. Never throws for provider problems — those
   *  are results, because the caller has to decide whether to wait,
   *  fall through, or give up, and each of those is visible in the UI. */
  async function attemptOnce(candidate: { model: string; label: string }): Promise<
    | { ok: true; text: string; resolvedModel?: string; costUsd: number | null; messages: GCMessage[] }
    | { ok: false; error: string }
  > {
    const messages: GCMessage[] = [];
    const abortController = new AbortController();
    const forward = () => abortController.abort();
    opts.signal?.addEventListener("abort", forward, { once: true });

    try {
      const q = query({
        prompt: opts.prompt,
        dir: opts.agentDir,
        model: candidate.model,
        ...(systemPrompt ? { systemPrompt } : {}),
        allowedTools: PERMITTED_TOOLS,
        hooks: buildHooks(worktreeRoot),
        // Enough for read → read → backtest → write → answer with room
        // to recover from one mistake, and no more: every extra turn
        // re-sends the whole conversation, and on an 8000 token/minute
        // budget a long transcript is what turns a working proposal
        // into a 413.
        maxTurns: 6,
        abortController,
        constraints: { temperature: 0.2, maxTokens: 2048 },
      });

      let finalText = "";
      let sawHardError = false;
      let errorDetail = "";
      let resolvedModel: string | undefined;
      let costUsd: number | null = null;

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

      if (opts.signal?.aborted) throw new AgentCancelledError();
      if (sawHardError || !finalText.trim()) {
        return { ok: false, error: errorDetail || "the model returned an empty response" };
      }
      return { ok: true, text: finalText, resolvedModel, costUsd, messages };
    } catch (err) {
      if (err instanceof AgentCancelledError || opts.signal?.aborted) throw new AgentCancelledError();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      opts.signal?.removeEventListener("abort", forward);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new AgentCancelledError());
        },
        { once: true },
      );
    });
  }

  for (const candidate of chain) {
    // At most one wait-and-retry per model, then move on.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (opts.signal?.aborted) throw new AgentCancelledError();
      const startedAt = Date.now();
      const result = await attemptOnce(candidate);
      const ms = Date.now() - startedAt;

      if (result.ok) {
        providerAttempts.push({
          model: candidate.model,
          label: candidate.label,
          ok: true,
          resolvedModel: result.resolvedModel,
          ms,
        });
        const { text, commitMsg } = extractCommitMsg(result.text);
        const { backtest, error: backtestError } = extractBacktest(result.messages);
        return { text, commitMsg, backtest, backtestError, providerAttempts, costUsd: result.costUsd };
      }

      const wait = attempt === 0 && isRateLimit(result.error) ? retryAfterMs(result.error) : null;
      providerAttempts.push({
        model: candidate.model,
        label: candidate.label,
        ok: false,
        error: wait ? `${result.error} — waited ${Math.round(wait / 1000)}s and retried` : result.error,
        ms,
      });
      if (!wait) break;
      await sleep(wait);
    }
  }

  throw new AllProvidersFailedError(providerAttempts);
}
