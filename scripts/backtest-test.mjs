#!/usr/bin/env node
// Tests the backtest tool end to end through its real stdin/stdout
// contract, with no model involved.
//
// The load-bearing property here is not the arithmetic -- it's that
// `patched_yaml` is a surgical edit of the live file rather than a
// re-serialization of it. The whole product is "a rule change you can
// read as a diff"; a tool that reformats the file on every write
// destroys that, so each case below asserts on the size and content of
// the resulting diff, not just on the values.
//
// Run: node scripts/backtest-test.mjs

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "agent", "tools", "scripts", "backtest.mjs");
const RULESET = path.join(ROOT, "agent", "rules", "active-ruleset.yaml");

let failures = 0;
let checks = 0;
function ok(label, cond, detail = "") {
  checks += 1;
  console.log(`   ${cond ? "✓" : "✗"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

async function run(candidateRules) {
  const child = execFileAsync("node", [TOOL], { maxBuffer: 8 * 1024 * 1024 });
  child.child.stdin.end(JSON.stringify({ candidate_rules_json: JSON.stringify(candidateRules) }));
  try {
    const { stdout } = await child;
    return JSON.parse(stdout);
  } catch (err) {
    // The tool reports refusals as JSON on stdout with a non-zero exit.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "rd-backtest-"));

/** Real unified diff between the live ruleset and a candidate text --
 *  the same thing the workbench's evidence pane renders. */
async function diffLines(after) {
  const file = path.join(TMP, "candidate.yaml");
  writeFileSync(file, after);
  let out = "";
  try {
    await execFileAsync("diff", ["-u", RULESET, file]);
  } catch (err) {
    out = err.stdout ?? "";
  }
  const lines = out.split("\n");
  return {
    added: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)),
    removed: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1)),
  };
}

const LIVE = [
  {
    id: "velocity-new-device",
    description: "Flag transfers over ₹50,000 from a device seen for the first time in the last 24 hours.",
    condition: { type: "velocity", field: "device_age_hours", operator: "lt", threshold_hours: 24, amount_threshold_inr: 50000 },
    action: "flag_for_review",
    severity: "high",
  },
  {
    id: "geo-mismatch",
    description: "Flag transactions where the billing country differs from the device's IP country and the amount exceeds ₹20,000.",
    condition: { type: "geo_mismatch", amount_threshold_inr: 20000 },
    action: "flag_for_review",
    severity: "medium",
  },
  {
    id: "rapid-succession",
    description: "Flag more than 4 transactions from the same account within a 10-minute window.",
    condition: { type: "frequency", window_minutes: 10, count_threshold: 4 },
    action: "flag_for_review",
    severity: "medium",
  },
];

const clone = () => JSON.parse(JSON.stringify(LIVE));

console.log("\n1. baseline: the live ruleset scored against itself");
{
  const r = await run(clone());
  ok("scores 600 historical transactions", r.current.total_transactions === 600, String(r.current?.total_transactions));
  ok("an unchanged candidate has a zero delta", r.delta.catch_rate === 0 && r.delta.false_positive_rate === 0);
  ok("catch rate is realistic, not a suspicious 100%", r.current.catch_rate > 0.2 && r.current.catch_rate < 0.6, String(r.current.catch_rate));
  ok("false positives are reported alongside it", typeof r.current.false_positive_rate === "number");
  const { added, removed } = await diffLines(r.patched_yaml);
  ok("an unchanged ruleset only bumps the version line", added.length === 1 && removed.length === 1, `+${added.length}/-${removed.length}`);
}

console.log("\n2. a one-line threshold change stays a one-line diff");
{
  const cand = clone();
  cand[0].condition.amount_threshold_inr = 25000;
  const r = await run(cand);
  const { added, removed } = await diffLines(r.patched_yaml);
  console.log(`   ${removed.join("\n   ")}\n   ${added.join("\n   ")}`);
  ok("exactly the version line and the threshold move", added.length === 2 && removed.length === 2, `+${added.length}/-${removed.length}`);
  ok("the file's comments survive", r.patched_yaml.includes("# The agent never commits to this file on `main`"));
  ok("the folded description is untouched", r.patched_yaml.includes("      Flag transfers over ₹50,000 from a device seen for the first\n      time in the last 24 hours."));
  ok("the patch is summarized in plain language", r.patch_summary.includes("velocity-new-device: amount_threshold_inr 50000 → 25000"), JSON.stringify(r.patch_summary));
  ok("catching more fraud is reflected in the delta", r.delta.catch_rate > 0, String(r.delta.catch_rate));
  ok("and so is its false-positive cost", r.delta.false_positive_rate > 0, String(r.delta.false_positive_rate));
}

console.log("\n3. a severity change touches one line");
{
  const cand = clone();
  cand[1].severity = "high";
  const r = await run(cand);
  const { added } = await diffLines(r.patched_yaml);
  ok("version + severity only", added.length === 2, `+${added.length}`);
  ok("summarized", r.patch_summary.some((c) => c.includes("severity medium → high")), JSON.stringify(r.patch_summary));
}

console.log("\n4. adding a rule appends a block and leaves the rest alone");
{
  const cand = clone();
  cand.push({
    id: "high-value-new-account",
    description: "Flag transfers over ₹200,000 from accounts whose device is under 2 hours old.",
    condition: { type: "velocity", field: "device_age_hours", operator: "lt", threshold_hours: 2, amount_threshold_inr: 200000 },
    action: "flag_for_review",
    severity: "high",
  });
  const r = await run(cand);
  const { removed } = await diffLines(r.patched_yaml);
  ok("nothing is removed except the old version line", removed.length === 1, removed.join(" | "));
  ok("the new rule is in the file", r.patched_yaml.includes("- id: high-value-new-account"));
  ok("the new rule is scored", typeof r.candidate.flags_per_rule["high-value-new-account"] === "number");
  ok("summarized as an addition", r.patch_summary.some((c) => c.includes("new rule added")));
}

console.log("\n5. removing a rule removes exactly its block");
{
  const cand = clone().filter((r) => r.id !== "geo-mismatch");
  const r = await run(cand);
  ok("the rule is gone", !r.patched_yaml.includes("- id: geo-mismatch"));
  ok("the other two survive", r.patched_yaml.includes("- id: velocity-new-device") && r.patched_yaml.includes("- id: rapid-succession"));
  ok("the header comment survives", r.patched_yaml.startsWith("# Live transaction-monitoring ruleset."));
  ok("fewer transactions are flagged", r.delta.total_flagged < 0, String(r.delta.total_flagged));
}

console.log("\n6. the tool warns instead of guessing");
{
  const cand = clone();
  cand[2].condition.window_minutes = 30;
  const r = await run(cand);
  // The dataset only precomputes a 10-minute count. A wrong number the
  // analyst can see beats a wrong number they can't.
  ok("an unsupported time window is warned about, not silently approximated", r.warnings.some((w) => w.includes("10-minute")), JSON.stringify(r.warnings));

  const bad = clone();
  bad[0].condition.type = "moon_phase";
  const r2 = await run(bad);
  ok("an unknown condition type is warned about", r2.warnings.some((w) => w.includes("unsupported condition type")), JSON.stringify(r2.warnings));
}

console.log("\n7. bad input is refused, not half-processed");
{
  const r = await run([]);
  ok("an empty candidate list is refused with a reason", typeof r.error === "string", JSON.stringify(r));
}

console.log(`\n${failures === 0 ? "BACKTEST TEST PASSED" : "BACKTEST TEST FAILED"} — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
