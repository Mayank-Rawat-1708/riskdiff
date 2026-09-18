import "dotenv/config";
import path from "node:path";
import os from "node:os";

function required(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  // Where the server keeps its own working clone of the repo for git
  // operations. Separate from wherever the app's own source was
  // checked out to run -- see server/src/repoManager.ts for why.
  runtimeDir: required("RUNTIME_DIR", path.join(os.tmpdir(), "riskdiff-runtime"))!,

  gitRepoUrl: process.env.GIT_REPO_URL, // e.g. https://github.com/you/riskdiff.git
  githubPat: process.env.GITHUB_PAT,
  gitAuthorName: required("GIT_AUTHOR_NAME", "Riska (RiskDiff agent)")!,
  gitAuthorEmail: required("GIT_AUTHOR_EMAIL", "riska-agent@riskdiff.local")!,

  // Path, relative to the repo root, of the OpenGAP agent directory.
  agentSubdir: required("AGENT_SUBDIR", "agent")!,

  corsOrigin: process.env.CORS_ORIGIN, // e.g. your Render static site URL, if split
};

export interface ModelCandidate {
  model: string; // "provider:model-id", as gitagent expects
  label: string; // human-readable, for the UI's provider-attempt log
}

/**
 * Builds the ordered fallback chain from whichever API keys are
 * actually present in the environment. Groq is tried first because
 * that's the key this deployment was built around (see agent/agent.yaml
 * comments); OpenAI and Anthropic are added only if their keys exist,
 * so a deployment with only a Groq key never wastes a call on a
 * provider that's guaranteed to auth-fail.
 */
export function buildModelChain(): ModelCandidate[] {
  const chain: ModelCandidate[] = [];

  if (process.env.GROQ_API_KEY) {
    chain.push(
      { model: "groq:openai/gpt-oss-120b", label: "Groq / GPT-OSS 120B" },
      { model: "groq:llama-3.3-70b-versatile", label: "Groq / Llama 3.3 70B" },
      { model: "groq:llama-3.1-8b-instant", label: "Groq / Llama 3.1 8B Instant" },
    );
  }
  if (process.env.OPENAI_API_KEY) {
    chain.push({ model: "openai:gpt-4o-mini", label: "OpenAI / GPT-4o mini" });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    chain.push({ model: "anthropic:claude-sonnet-4-5-20250929", label: "Anthropic / Claude Sonnet 4.5" });
  }

  return chain;
}
