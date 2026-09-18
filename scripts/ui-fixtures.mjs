#!/usr/bin/env node
/**
 * Design harness. Serves the same /api shapes as the real server, with
 * one proposal per UI state so every screen — including the ones that
 * only happen when something goes wrong — can be looked at, in both
 * themes, without a model provider or a lucky failure.
 *
 * THIS IS NOT THE PRODUCT. Nothing here talks to git or to a model.
 * The only numbers in it are real: the backtest figures are produced by
 * running agent/tools/scripts/backtest.mjs against the actual dataset at
 * startup, because the whole point of the evidence pane is that its
 * numbers mean something, and designing it against invented ones would
 * teach me the wrong thing about how they lay out.
 *
 *   node scripts/ui-fixtures.mjs           # port 8080, every state
 *   RD_SCENARIO=empty node scripts/...     # first-run, nothing yet
 *   RD_SCENARIO=nokey node scripts/...     # no model provider configured
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8080);
const SCENARIO = process.env.RD_SCENARIO ?? "full";

const RULESET = fs.readFileSync(path.join(ROOT, "agent", "rules", "active-ruleset.yaml"), "utf8");

const LIVE_RULES = [
  { id: "velocity-new-device", description: "Flag transfers over ₹50,000 from a device seen for the first time in the last 24 hours.", condition: { type: "velocity", field: "device_age_hours", operator: "lt", threshold_hours: 24, amount_threshold_inr: 50000 }, action: "flag_for_review", severity: "high" },
  { id: "geo-mismatch", description: "Flag transactions where the billing country differs from the device's IP country and the amount exceeds ₹20,000.", condition: { type: "geo_mismatch", amount_threshold_inr: 20000 }, action: "flag_for_review", severity: "medium" },
  { id: "rapid-succession", description: "Flag more than 4 transactions from the same account within a 10-minute window.", condition: { type: "frequency", window_minutes: 10, count_threshold: 4 }, action: "flag_for_review", severity: "medium" },
];

async function backtest(mutate) {
  const cand = JSON.parse(JSON.stringify(LIVE_RULES));
  mutate(cand);
  const child = execFileAsync("node", [path.join(ROOT, "agent", "tools", "scripts", "backtest.mjs")], { maxBuffer: 8e6 });
  child.child.stdin.end(JSON.stringify({ candidate_rules_json: JSON.stringify(cand) }));
  const { stdout } = await child;
  return JSON.parse(stdout);
}

function diffFor(oldLine, newLine, version = [4, 5]) {
  return `diff --git a/agent/rules/active-ruleset.yaml b/agent/rules/active-ruleset.yaml
index 37a4df6..e44a67f 100644
--- a/agent/rules/active-ruleset.yaml
+++ b/agent/rules/active-ruleset.yaml
@@ -4,7 +4,7 @@
 # left pane. It is only ever changed by: (a) an analyst merging an
 # approved proposal branch, or (b) an analyst reverting a past commit.
 # The agent never commits to this file on \`main\` — see RULES.md.
-version: ${version[0]}
+version: ${version[1]}
 rules:
   - id: velocity-new-device
     description: >
@@ -15,7 +15,7 @@ rules:
       field: device_age_hours
       operator: lt
       threshold_hours: 24
-${oldLine}
+${newLine}
     action: flag_for_review
     severity: high
`;
}

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();

const HISTORY = [
  { sha: "b7e21c4a9f3d5e8c1b2a4d6f8e0c2a4b6d8f0e2c", shortSha: "b7e21c4", date: ago(180), message: "Record rejected proposal: proposal/low-value-cross-border-mq3x", author: "Riska (RiskDiff agent)", isRoot: false, touchesRuleset: false, touchesMemory: true, kind: "decision", canRevert: false },
  { sha: "3f9a1d7e5c2b8a4f6d0e2c4a6b8d0f2e4c6a8b0d", shortSha: "3f9a1d7", date: ago(1440), message: "Tighten rapid-succession threshold from 6 to 4", author: "Riska (RiskDiff agent)", isRoot: false, touchesRuleset: true, touchesMemory: true, kind: "change", canRevert: true },
  { sha: "8c4b2e6a0d8f2c4e6a8b0d2f4e6c8a0b2d4f6e8c", shortSha: "8c4b2e6", date: ago(4320), message: "Add geo-mismatch rule after cross-border chargeback cluster", author: "Riska (RiskDiff agent)", isRoot: false, touchesRuleset: true, touchesMemory: true, kind: "change", canRevert: true },
  { sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", shortSha: "1a2b3c4", date: ago(20160), message: "Seed local-only runtime repo (no GIT_REPO_URL configured)", author: "Riska (RiskDiff agent)", isRoot: true, touchesRuleset: true, touchesMemory: true, kind: "seed", canRevert: false },
];

const COMMIT_DETAIL = {
  "3f9a1d7e5c2b8a4f6d0e2c4a6b8d0f2e4c6a8b0d": {
    rulesetDiff: `commit 3f9a1d7e5c2b8a4f6d0e2c4a6b8d0f2e4c6a8b0d
diff --git a/agent/rules/active-ruleset.yaml b/agent/rules/active-ruleset.yaml
@@ -33,7 +33,7 @@ rules:
     condition:
       type: frequency
       window_minutes: 10
-      count_threshold: 6
+      count_threshold: 4
     action: flag_for_review
     severity: medium
`,
    memoryDiff: `@@ -12,0 +13,4 @@
+### 2026-08-14 — approved — \`rapid-succession\` threshold 6 → 4
+Analyst note: fraud ring last month sent 5 transfers in under 10 minutes
+to stay under the old threshold of 6. Accepted; the FP cost was judged
+worth it after the incident review.
`,
  },
};

const attempt = (label, model, ok, error, ms) => ({ label, model, ok, error, ms, resolvedModel: ok ? model : undefined });

async function buildProposals() {
  if (SCENARIO !== "full") return [];

  const healthy = await backtest((r) => (r[0].condition.amount_threshold_inr = 25000));
  const noisy = await backtest((r) => (r[1].condition.amount_threshold_inr = 5000));
  const fallbackBt = await backtest((r) => (r[2].condition.count_threshold = 3));

  return [
    {
      id: "p-ready",
      branch: "proposal/chargebacks-under-50k-new-devices-mu76",
      incidentDescription: "Three chargebacks this week, all under ₹50k from devices first seen that day. Feels like the velocity threshold is too high.",
      createdAt: ago(9),
      recovered: false,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      lastError: null,
      behindMain: 0,
      conflict: null,
      hadChanges: true,
      diff: diffFor("      amount_threshold_inr: 50000", "      amount_threshold_inr: 25000"),
      turns: [
        {
          role: "agent",
          at: ago(8),
          text: `Pattern: sub-₹50,000 transfers from new devices are getting through because velocity-new-device only fires above ₹50,000.

Memory check: no entry in the last 10 touches this rule's amount threshold. The closest is 2026-07-29, where a geo-mismatch threshold cut to ₹5,000 was rejected for tripling false positives — different rule, but the same shape of trade.

Backtest, lowering amount_threshold_inr from 50000 to 25000:
- catch rate 32.7% → 36.5% (+3.8pp)
- false-positive rate 11.1% → 13.3% (+2.2pp)
- precision 38.2% → 36.5% (−1.7pp)

In counts: 4 more frauds caught, 11 more legitimate transactions sent to manual review. That's roughly 3 false positives per additional catch, and precision falls.

Recommendation: take it if these three chargebacks are the start of a pattern rather than one bad week. If the review queue is already backed up, ₹35,000 would be the softer version and I can backtest that instead.`,
          commitMsg: "Lower new-device velocity threshold to 25,000",
          backtest: healthy,
          backtestError: null,
          unexpectedFileChanges: [],
          noRulesetChange: false,
          costUsd: 0.0021,
          providerAttempts: [attempt("Groq / GPT-OSS 120B", "groq:openai/gpt-oss-120b", true, undefined, 5840)],
        },
      ],
    },
    {
      id: "p-running",
      branch: "proposal/card-testing-burst-on-new-accounts-mu77",
      incidentDescription: "Card-testing burst overnight — a dozen accounts each running 8-10 tiny auths in under two minutes.",
      createdAt: ago(1),
      recovered: false,
      phase: "running",
      phaseLabel: "Drafting a rule change",
      startedAt: ago(0.4),
      lastError: null,
      behindMain: 0,
      conflict: null,
      hadChanges: false,
      diff: "",
      turns: [],
    },
    {
      id: "p-fallback",
      branch: "proposal/rapid-succession-still-too-loose-mu78",
      incidentDescription: "The rapid-succession rule is still letting 3-transfer bursts through.",
      createdAt: ago(40),
      recovered: false,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      lastError: null,
      behindMain: 0,
      conflict: null,
      hadChanges: true,
      diff: diffFor("      count_threshold: 4", "      count_threshold: 3", [4, 5]).replace("amount_threshold_inr", "count_threshold"),
      turns: [
        {
          role: "agent",
          at: ago(39),
          text: `Pattern: three-transfer bursts sit under the current count_threshold of 4 and never flag.

Backtest, lowering count_threshold from 4 to 3:
- catch rate 32.7% → 40.4% (+7.7pp)
- false-positive rate 11.1% → 19.6% (+8.5pp)
- precision 38.2% → 30.0% (−8.2pp)

This is a bad trade and I'm saying so up front: 8 more frauds caught costs 42 more legitimate transactions in the review queue, and precision drops by more than the catch rate gains. The rapid-succession rule is already the highest-volume flagger in the set.

Recommendation: don't take this one on velocity alone. A better-shaped version pairs the count with an amount floor, which is a two-condition change and outside what one proposal should carry.`,
          commitMsg: "Lower rapid-succession count threshold to 3",
          backtest: fallbackBt,
          backtestError: null,
          unexpectedFileChanges: [],
          noRulesetChange: false,
          costUsd: 0.0009,
          providerAttempts: [
            attempt("Groq / GPT-OSS 120B", "groq:openai/gpt-oss-120b", false, "429 Rate limit reached for model `openai/gpt-oss-120b` — limit 14400 tokens/min", 410),
            attempt("Groq / Llama 3.3 70B", "groq:llama-3.3-70b-versatile", false, "429 Rate limit reached", 260),
            attempt("OpenAI / GPT-4o mini", "openai:gpt-4o-mini", true, undefined, 7210),
          ],
        },
      ],
    },
    {
      id: "p-misbehaved",
      branch: "proposal/geo-rule-too-noisy-for-travellers-mu79",
      incidentDescription: "Support says travellers are getting flagged constantly on the geo rule.",
      createdAt: ago(70),
      recovered: false,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      lastError: null,
      behindMain: 0,
      conflict: null,
      hadChanges: true,
      diff: diffFor("      amount_threshold_inr: 20000", "      amount_threshold_inr: 5000"),
      turns: [
        {
          role: "agent",
          at: ago(69),
          text: `Dropped the geo-mismatch amount threshold to ₹5,000 so more cross-border activity is caught. This should help with the traveller complaints.`,
          commitMsg: null,
          backtest: null,
          backtestError: "backtest tool exited 1: candidate_rules_json must be a non-empty JSON array of rule objects",
          unexpectedFileChanges: ["agent/memory/MEMORY.md", "agent/RULES.md"],
          noRulesetChange: false,
          costUsd: 0.0004,
          providerAttempts: [attempt("Groq / Llama 3.1 8B Instant", "groq:llama-3.1-8b-instant", true, undefined, 1100)],
        },
      ],
    },
    {
      id: "p-conflict",
      branch: "proposal/velocity-window-to-48h-mu7a",
      incidentDescription: "Devices are being aged past 24 hours before the first big transfer — widen the window.",
      createdAt: ago(200),
      recovered: false,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      lastError: null,
      behindMain: 2,
      conflict: { paths: ["agent/rules/active-ruleset.yaml"], at: ago(2) },
      hadChanges: true,
      diff: diffFor("      threshold_hours: 24", "      threshold_hours: 48"),
      turns: [
        {
          role: "agent",
          at: ago(199),
          text: `Pattern: fraud is waiting out the 24-hour device-age window before the first large transfer.

Backtest, widening threshold_hours from 24 to 48:
- catch rate 32.7% → 35.6% (+2.9pp)
- false-positive rate 11.1% → 14.9% (+3.8pp)
- precision 38.2% → 33.0% (−5.2pp)

Recommendation: marginal. The window change catches 3 more frauds and costs 19 more reviews.`,
          commitMsg: "Widen new-device velocity window to 48 hours",
          backtest: noisy,
          backtestError: null,
          unexpectedFileChanges: [],
          noRulesetChange: false,
          costUsd: 0.0018,
          providerAttempts: [attempt("Groq / GPT-OSS 120B", "groq:openai/gpt-oss-120b", true, undefined, 6100)],
        },
        { role: "analyst", at: ago(190), text: "Can you check whether 36 hours is a better middle ground?" },
        {
          role: "agent",
          at: ago(188),
          text: `36 hours lands between the two, as you'd expect: catch rate 34.6% (+1.9pp), false positives 13.2% (+2.1pp). Fewer reviews than 48h for most of the catch. I've left the draft at 48 rather than changing it under you — say the word and I'll move it.`,
          commitMsg: "Widen new-device velocity window to 48 hours",
          backtest: noisy,
          backtestError: null,
          unexpectedFileChanges: [],
          noRulesetChange: true,
          costUsd: 0.0012,
          providerAttempts: [attempt("Groq / GPT-OSS 120B", "groq:openai/gpt-oss-120b", true, undefined, 4300)],
        },
      ],
    },
    {
      id: "p-failed",
      branch: "proposal/amount-floor-on-frequency-rule-mu7b",
      incidentDescription: "Add an amount floor to the frequency rule so tiny auth bursts stop filling the queue.",
      createdAt: ago(15),
      recovered: false,
      phase: "failed",
      phaseLabel: null,
      startedAt: null,
      lastError: "Every configured model provider failed (4 tried).",
      behindMain: 0,
      conflict: null,
      hadChanges: false,
      diff: "",
      turns: [
        {
          role: "agent",
          at: ago(14),
          text: "",
          providerAttempts: [
            attempt("Groq / GPT-OSS 120B", "groq:openai/gpt-oss-120b", false, "401 Invalid API Key", 180),
            attempt("Groq / Llama 3.3 70B", "groq:llama-3.3-70b-versatile", false, "401 Invalid API Key", 140),
            attempt("Groq / Llama 3.1 8B Instant", "groq:llama-3.1-8b-instant", false, "401 Invalid API Key", 130),
            attempt("OpenAI / GPT-4o mini", "openai:gpt-4o-mini", false, "429 You exceeded your current quota, please check your plan and billing details", 320),
          ],
        },
      ],
    },
    {
      id: "p-recovered",
      branch: "proposal/chargeback-cluster-from-one-bin-mu7c",
      incidentDescription: "(recovered from the branch — this proposal predates the on-branch transcript)",
      createdAt: ago(600),
      recovered: true,
      phase: "idle",
      phaseLabel: null,
      startedAt: null,
      lastError: "Recovered from git with no transcript on the branch. The branch, its commits and its diff survived; the conversation did not.",
      behindMain: 1,
      conflict: null,
      hadChanges: true,
      diff: diffFor("      amount_threshold_inr: 50000", "      amount_threshold_inr: 30000"),
      turns: [],
    },
  ];
}

const proposals = await buildProposals();

const status = {
  empty: { repoMode: "local-only", runtimeMode: "local-only", modelChain: ["Groq / GPT-OSS 120B", "Groq / Llama 3.3 70B", "Groq / Llama 3.1 8B Instant"], hasGitRepoUrl: false, pushError: null },
  nokey: { repoMode: "local-only", runtimeMode: "local-only", modelChain: [], hasGitRepoUrl: false, pushError: null },
  full: { repoMode: "remote", runtimeMode: "remote", modelChain: ["Groq / GPT-OSS 120B", "Groq / Llama 3.3 70B", "Groq / Llama 3.1 8B Instant", "OpenAI / GPT-4o mini"], hasGitRepoUrl: true, pushError: null },
}[SCENARIO];

const DIST = path.join(ROOT, "web", "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/api/status") return json(res, 200, status);
    if (p === "/api/rules") return json(res, 200, { yaml: RULESET, rules: LIVE_RULES.map(({ id, description, action, severity }) => ({ id, description, action, severity })), history: SCENARIO === "empty" ? HISTORY.slice(-1) : HISTORY });
    if (p.startsWith("/api/rules/history/")) {
      const sha = p.split("/").pop();
      const found = Object.entries(COMMIT_DETAIL).find(([k]) => k.startsWith(sha));
      return json(res, 200, found ? found[1] : { rulesetDiff: "", memoryDiff: "" });
    }
    if (p === "/api/proposals") return json(res, 200, { proposals });
    if (p.startsWith("/api/proposals/")) {
      const id = p.split("/")[3];
      const found = proposals.find((x) => x.id === id);
      if (!found) return json(res, 404, { error: "This proposal is no longer open." });
      if (p.endsWith("/approve") && found.conflict) {
        return json(res, 409, { error: "merge conflict in agent/rules/active-ruleset.yaml", conflict: found.conflict.paths });
      }
      return json(res, 200, found);
    }
    if (p.startsWith("/api/")) return json(res, 404, { error: "fixture server: no such endpoint" });

    const file = p === "/" ? "/index.html" : p;
    const abs = path.join(DIST, file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(abs)] ?? "application/octet-stream" });
      return fs.createReadStream(abs).pipe(res);
    }
    const index = path.join(DIST, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html" });
      return fs.createReadStream(index).pipe(res);
    }
    res.writeHead(404).end("build web/ first, or run vite dev and let it proxy /api here");
  })
  .listen(PORT, () => console.log(`RiskDiff UI fixtures (${SCENARIO}) on http://localhost:${PORT} — not the real server`));
