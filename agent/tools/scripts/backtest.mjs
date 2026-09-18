#!/usr/bin/env node
// Backtests a candidate ruleset against the historical labeled dataset and
// diffs it against the current live ruleset.
//
// Deliberately dependency-free: this script is invoked as a child process
// by name (`runtime: node`) from an unpredictable working directory /
// module-resolution context, so it hand-rolls a tiny CSV reader and a
// tiny YAML *serializer* (never a parser -- see rules_json below for why
// that's avoidable) rather than pull in a package that may not resolve
// from wherever gitagent actually launches it. See NOTES.md.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RULESET_PATH = path.join(AGENT_ROOT, "rules", "active-ruleset.yaml");
const DATA_PATH = path.join(AGENT_ROOT, "data", "transactions.csv");

function readStdin() {
  const chunks = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i]));
    row.amount_inr = Number(row.amount_inr);
    row.device_age_hours = Number(row.device_age_hours);
    row.account_tx_count_10min = Number(row.account_tx_count_10min);
    row.is_fraud = Number(row.is_fraud) === 1;
    return row;
  });
}

// Extracts the `rules:` list out of the current hand-written YAML file
// using a parser restricted to exactly this repo's schema (flat scalars
// and one level of nested `condition:` map). This is not a general YAML
// parser and will not survive the schema growing much beyond what
// RULES.md item 2 already keeps small (one rule change per proposal).
function parseCurrentRuleset(yamlText) {
  const rules = [];
  let current = null;
  let inCondition = false;
  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (/^\s*-\s+id:/.test(line)) {
      if (current) rules.push(current);
      current = { condition: {} };
      inCondition = false;
      current.id = line.split("id:")[1].trim();
      continue;
    }
    if (!current) continue;
    const m = line.match(/^\s*([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    if (key === "condition") {
      inCondition = true;
      continue;
    }
    if (inCondition && line.match(/^\s{6,}/)) {
      current.condition[key] = coerce(val);
    } else if (["description", "action", "severity"].includes(key)) {
      inCondition = false;
      if (val) current[key] = val.replace(/^>-?\s*/, "").trim();
    }
  }
  if (current) rules.push(current);
  return rules;
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function evaluateRule(rule, row, warnings) {
  const c = rule.condition || {};
  switch (c.type) {
    case "velocity": {
      const field = c.field || "device_age_hours";
      const fieldVal = row[field];
      const cmp = { lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b }[c.operator || "lt"];
      if (!cmp) {
        warnings.add(`rule ${rule.id}: unsupported operator "${c.operator}"`);
        return false;
      }
      return row.amount_inr > (c.amount_threshold_inr ?? 0) && cmp(fieldVal, c.threshold_hours ?? 0);
    }
    case "geo_mismatch":
      return row.billing_country !== row.ip_country && row.amount_inr > (c.amount_threshold_inr ?? 0);
    case "frequency":
      if (c.window_minutes && Number(c.window_minutes) !== 10) {
        warnings.add(`rule ${rule.id}: dataset only precomputes a 10-minute window; window_minutes=${c.window_minutes} was evaluated against the 10-minute count as an approximation`);
      }
      return row.account_tx_count_10min >= (c.count_threshold ?? Infinity);
    default:
      warnings.add(`rule ${rule.id}: unsupported condition type "${c.type}" -- excluded from this backtest`);
      return false;
  }
}

function scoreRuleset(rules, rows, warnings) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const perRule = Object.fromEntries(rules.map((r) => [r.id, 0]));
  for (const row of rows) {
    let flagged = false;
    for (const rule of rules) {
      if (evaluateRule(rule, row, warnings)) {
        flagged = true;
        perRule[rule.id] += 1;
      }
    }
    if (flagged && row.is_fraud) tp += 1;
    else if (flagged && !row.is_fraud) fp += 1;
    else if (!flagged && row.is_fraud) fn += 1;
    else tn += 1;
  }
  const catchRate = tp + fn > 0 ? tp / (tp + fn) : null;
  const falsePositiveRate = fp + tn > 0 ? fp / (fp + tn) : null;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  return {
    total_transactions: rows.length,
    total_flagged: tp + fp,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
    catch_rate: round(catchRate),
    false_positive_rate: round(falsePositiveRate),
    precision: round(precision),
    flags_per_rule: perRule,
  };
}

function round(n) {
  return n === null ? null : Math.round(n * 1000) / 1000;
}

function deltaOf(a, b) {
  if (a === null || b === null) return null;
  return round(a - b);
}

function toYaml(rules) {
  const lines = ["version: __VERSION__", "rules:"];
  for (const r of rules) {
    lines.push(`  - id: ${r.id}`);
    if (r.description) lines.push(`    description: ${r.description}`);
    lines.push("    condition:");
    lines.push(`      type: ${r.condition.type}`);
    for (const [k, v] of Object.entries(r.condition)) {
      if (k === "type") continue;
      lines.push(`      ${k}: ${v}`);
    }
    if (r.action) lines.push(`    action: ${r.action}`);
    if (r.severity) lines.push(`    severity: ${r.severity}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

async function main() {
  const raw = await readStdin();
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ error: "backtest tool received non-JSON stdin" }));
    process.exit(1);
  }

  let candidateRules;
  try {
    candidateRules = JSON.parse(args.candidate_rules_json);
    if (!Array.isArray(candidateRules) || candidateRules.length === 0) throw new Error("empty");
  } catch {
    process.stdout.write(JSON.stringify({ error: "candidate_rules_json must be a non-empty JSON array of rule objects" }));
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(DATA_PATH, "utf8"));
  const currentRules = parseCurrentRuleset(readFileSync(RULESET_PATH, "utf8"));

  const warnings = new Set();
  const current = scoreRuleset(currentRules, rows, warnings);
  const candidate = scoreRuleset(candidateRules, rows, warnings);

  const delta = {
    catch_rate: deltaOf(candidate.catch_rate, current.catch_rate),
    false_positive_rate: deltaOf(candidate.false_positive_rate, current.false_positive_rate),
    precision: deltaOf(candidate.precision, current.precision),
    total_flagged: candidate.total_flagged - current.total_flagged,
  };

  const currentVersionMatch = readFileSync(RULESET_PATH, "utf8").match(/^version:\s*(\d+)/m);
  const nextVersion = currentVersionMatch ? Number(currentVersionMatch[1]) + 1 : 1;
  const formattedYaml = toYaml(candidateRules).replace("__VERSION__", String(nextVersion));

  process.stdout.write(JSON.stringify({
    current,
    candidate,
    delta,
    formatted_yaml: formattedYaml,
    warnings: [...warnings],
  }));
}

main();
