import path from "node:path";
import os from "node:os";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve .env from the repo root rather than the process cwd. `npm
// start` runs the server from server/, so a bare `dotenv/config` looks
// in the wrong directory, finds nothing, and the deployment silently
// comes up with no API key and no explanation.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

/**
 * Reads an environment variable, treating blank as unset.
 *
 * `.env.example` ships every key with an empty value, so `GIT_REPO_URL=`
 * and `RUNTIME_DIR=` are the *normal* state of a fresh checkout. With a
 * plain `??`, an empty string is a real value: `RUNTIME_DIR=` became
 * `mkdir('')` at boot, and an empty `GIT_REPO_URL=` convinced the server
 * it had a remote and sent it to clone `""`.
 */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback;
}

export const config = {
  port: Number(env("PORT") ?? 8080),

  // Where the server keeps its own working clone of the repo for git
  // operations. Separate from wherever the app's own source was
  // checked out to run -- see server/src/repoManager.ts for why.
  runtimeDir: envOr("RUNTIME_DIR", path.join(os.tmpdir(), "riskdiff-runtime")),

  gitRepoUrl: env("GIT_REPO_URL"), // e.g. https://github.com/you/riskdiff.git
  githubPat: env("GITHUB_PAT"),
  gitAuthorName: envOr("GIT_AUTHOR_NAME", "Riska (RiskDiff agent)"),
  gitAuthorEmail: envOr("GIT_AUTHOR_EMAIL", "riska-agent@riskdiff.local"),

  // Path, relative to the repo root, of the OpenGAP agent directory.
  agentSubdir: envOr("AGENT_SUBDIR", "agent"),

  corsOrigin: env("CORS_ORIGIN"), // e.g. your Render static site URL, if split
};

export interface ModelCandidate {
  model: string; // "provider:model-id", as gitagent expects
  label: string; // human-readable, for the UI's provider-attempt log
}

/**
 * The ordered fallback chain, built from whichever API keys are actually
 * present. A provider with no key is skipped rather than tried and
 * failed, so a Groq-only deployment never burns a call on a guaranteed
 * auth error.
 *
 * Every id here was checked twice: against GET /v1/models on a live key
 * (does the provider still serve it?) and against the SDK's own model
 * registry (can pi-ai construct it?). Both checks earned their place:
 *
 *  - `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` sat in this
 *    chain long after Groq decommissioned them (2026-08-16), 404ing on
 *    every call. Invisible while the first model works; fatal when it
 *    doesn't.
 *  - `qwen/qwen3.8-27b` is live on Groq but absent from pi-ai's bundled
 *    registry, so `getModel()` returns undefined and the SDK dies
 *    dereferencing it ("Cannot read properties of undefined (reading
 *    'headers')") in 0ms, before any HTTP call. The SDK's custom-
 *    endpoint escape hatch (`provider:id@base-url`) does construct it,
 *    but it ignores `constraints.maxTokens` and sends a
 *    max_completion_tokens above Qwen's 16384 ceiling, so every request
 *    400s. Left out rather than worked around.
 *
 * Note the registry is stale in both directions — it still lists the
 * two dead llama ids — so the provider's own catalogue is the
 * authority for what is live, and the registry only for what the SDK
 * can build. If you change an id, check both.
 * https://console.groq.com/docs/deprecations
 */
const PROVIDER_LABELS: Record<string, string> = { groq: "Groq", openai: "OpenAI", anthropic: "Anthropic" };

function labelFor(model: string): string {
  const [provider, ...rest] = model.split(":");
  const id = rest.join(":");
  return `${PROVIDER_LABELS[provider] ?? provider} / ${id.split("/").pop() ?? id}`;
}

export function buildModelChain(): ModelCandidate[] {
  // Operator override: a comma-separated list of provider:model ids
  // replaces the chain entirely. Pins a specific model when one starts
  // misbehaving, and is how the fallback models get exercised in
  // testing — otherwise the first entry always answers and the rest of
  // the chain is only ever seen when it's already too late.
  const override = env("MODEL_CHAIN");
  if (override) {
    return override
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .map((model) => ({ model, label: labelFor(model) }));
  }

  const chain: ModelCandidate[] = [];

  if (env("GROQ_API_KEY")) {
    chain.push(
      { model: "groq:openai/gpt-oss-120b", label: "Groq / GPT-OSS 120B" },
      { model: "groq:openai/gpt-oss-20b", label: "Groq / GPT-OSS 20B" },
      { model: "groq:openai/gpt-oss-safeguard-20b", label: "Groq / GPT-OSS Safeguard 20B" },
    );
  }
  if (env("OPENAI_API_KEY")) {
    chain.push({ model: "openai:gpt-4o-mini", label: "OpenAI / GPT-4o mini" });
  }
  if (env("ANTHROPIC_API_KEY")) {
    chain.push({ model: "anthropic:claude-sonnet-4-5-20250929", label: "Anthropic / Claude Sonnet 4.5" });
  }

  return chain;
}

/** One line at boot naming what actually resolved, so a deployment that
 *  came up without a key says so before an analyst discovers it by
 *  clicking Draft. */
export function describeEnvironment(): string {
  const chain = buildModelChain();
  const providers = chain.length
    ? chain.map((c) => c.label).join(" → ")
    : "NONE — set GROQ_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY in .env to draft proposals";
  const repo = config.gitRepoUrl ? `remote (${config.gitRepoUrl})` : "local-only (no GIT_REPO_URL)";
  return [
    `  .env         ${path.join(REPO_ROOT, ".env")}`,
    `  runtime dir  ${config.runtimeDir}`,
    `  git          ${repo}`,
    `  models       ${providers}`,
  ].join("\n");
}
