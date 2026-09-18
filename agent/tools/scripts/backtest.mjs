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
// using a parser restricted to exactly this repo's schema (flat scalars,
// one level of nested `condition:` map, folded `>` descriptions). This is
// not a general YAML parser and will not survive the schema growing much
// beyond what RULES.md item 2 already keeps small (one rule change per
// proposal).
function parseCurrentRuleset(yamlText) {
  const rules = [];
  let current = null;
  let inCondition = false;
  let conditionIndent = 0;
  let folding = null;
  let foldIndent = 0;

  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;

    if (/^\s*-\s+id:/.test(line)) {
      if (current) rules.push(current);
      current = { condition: {} };
      inCondition = false;
      folding = null;
      current.id = line.split("id:")[1].trim();
      continue;
    }
    if (!current) continue;

    // Continuation lines of a folded scalar belong to it whole, colons
    // included -- checking this before the key regex is what stops a
    // description sentence from being read as a key/value pair.
    if (folding && indent > foldIndent) {
      current[folding] = `${current[folding] ?? ""} ${line.trim()}`.trim();
      continue;
    }
    folding = null;

    if (/^\s*condition:\s*$/.test(line)) {
      inCondition = true;
      conditionIndent = indent;
      continue;
    }

    const m = line.match(/^\s*([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();

    if (inCondition && indent <= conditionIndent) inCondition = false;

    if (inCondition) {
      current.condition[key] = coerce(val);
    } else if (["description", "action", "severity"].includes(key)) {
      if (key === "description" && [">", ">-", "|", "|-"].includes(val)) {
        folding = "description";
        foldIndent = indent;
        current.description = "";
      } else if (val) {
        current[key] = val;
      }
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

// ---------------------------------------------------------------------
// Surgical YAML editing.
//
// The tool hands the agent back the exact file text to write, so that
// what was backtested and what gets committed can't drift apart. The
// naive way to do that is to re-serialize the candidate rules -- and
// that reformats the whole file, strips its comments, and unfolds every
// `description: >` block, turning a one-line threshold change into a
// diff that touches everything. A readable diff is the entire product,
// so instead this edits the original text in place: only the scalars
// that actually changed move, every other byte survives.
// ---------------------------------------------------------------------

/** Line positions of everything addressable in the ruleset text. */
function indexRuleset(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const index = { versionLine: -1, rules: [] };
  let current = null;

  const flushEnd = (i) => {
    if (current) current.endLine = i - 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (index.versionLine === -1 && /^version:\s*\d+/.test(line)) {
      index.versionLine = i;
      continue;
    }

    const idMatch = line.match(/^(\s*)-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      flushEnd(i);
      current = {
        id: idMatch[2].replace(/#.*$/, "").trim(),
        indent: idMatch[1].length + 2,
        startLine: i,
        endLine: lines.length - 1,
        keys: {},
        conditionLine: -1,
        conditionKeys: {},
        conditionEndLine: -1,
      };
      index.rules.push(current);
      continue;
    }
    if (!current) continue;

    if (/^\s*condition:\s*$/.test(line)) {
      current.conditionLine = i;
      current.conditionIndent = line.match(/^\s*/)[0].length;
      continue;
    }

    const kv = line.match(/^(\s*)([a-zA-Z_]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, pad, key, rawVal] = kv;
    const indent = pad.length;

    const inCondition = current.conditionLine !== -1 && indent > (current.conditionIndent ?? 0);
    if (inCondition) {
      current.conditionKeys[key] = { line: i, indent };
      current.conditionEndLine = i;
      continue;
    }

    // A rule-level key closes the condition block.
    if (current.conditionLine !== -1 && indent <= (current.conditionIndent ?? 0)) {
      current.conditionOpen = false;
    }

    const folded = rawVal === ">" || rawVal === ">-" || rawVal === "|" || rawVal === "|-";
    const entry = { line: i, indent, folded, endLine: i };
    if (folded) {
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" ? false : lines[j].match(/^\s*/)[0].length > indent)) {
        entry.endLine = j;
        j += 1;
      }
    }
    current.keys[key] = entry;
  }

  return { lines, index };
}

/** Same text normalization a folded YAML scalar goes through, so a
 *  re-wrapped description isn't mistaken for a changed one. */
function normalizeText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function renderFolded(key, indent, text) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [`${pad}${key}: >`];
  let line = "";
  for (const w of words) {
    if (line && (inner + line + " " + w).length > 74) {
      out.push(inner + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(inner + line);
  return out;
}

function renderRuleBlock(rule, indent = 2) {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  const out = [`${pad}- id: ${rule.id}`];
  if (rule.description) out.push(...renderFolded("description", indent + 2, rule.description));
  out.push(`${inner}condition:`);
  const cond = rule.condition || {};
  const keys = ["type", ...Object.keys(cond).filter((k) => k !== "type")];
  for (const k of keys) {
    if (cond[k] === undefined) continue;
    out.push(`${" ".repeat(indent + 4)}${k}: ${cond[k]}`);
  }
  if (rule.action) out.push(`${inner}action: ${rule.action}`);
  if (rule.severity) out.push(`${inner}severity: ${rule.severity}`);
  return out;
}

/**
 * Applies the candidate ruleset onto the current file text, touching
 * only what differs. Returns the new text plus a plain-language list of
 * what moved, which is what the workbench shows next to the diff.
 */
function patchRuleset(yamlText, currentRules, candidateRules) {
  const { lines, index } = indexRuleset(yamlText);
  const changes = [];
  // Edits are collected as line replacements and applied bottom-up so
  // earlier line numbers stay valid.
  const edits = [];
  const currentById = new Map(currentRules.map((r) => [r.id, r]));
  const indexById = new Map(index.rules.map((r) => [r.id, r]));

  for (const cand of candidateRules) {
    const cur = currentById.get(cand.id);
    const pos = indexById.get(cand.id);
    if (!cur || !pos) continue; // new rule, handled below

    for (const key of ["action", "severity"]) {
      if (cand[key] === undefined || !pos.keys[key]) continue;
      if (String(cur[key] ?? "") === String(cand[key])) continue;
      edits.push({ start: pos.keys[key].line, end: pos.keys[key].line, lines: [`${" ".repeat(pos.keys[key].indent)}${key}: ${cand[key]}`] });
      changes.push(`${cand.id}: ${key} ${cur[key]} → ${cand[key]}`);
    }

    if (cand.description !== undefined && pos.keys.description) {
      if (normalizeText(cur.description) !== normalizeText(cand.description)) {
        const k = pos.keys.description;
        edits.push({ start: k.line, end: k.endLine, lines: renderFolded("description", k.indent, cand.description) });
        changes.push(`${cand.id}: description rewritten`);
      }
    }

    const curCond = cur.condition || {};
    const candCond = cand.condition || {};
    for (const [k, v] of Object.entries(candCond)) {
      const at = pos.conditionKeys[k];
      if (at) {
        if (String(curCond[k]) === String(v)) continue;
        edits.push({ start: at.line, end: at.line, lines: [`${" ".repeat(at.indent)}${k}: ${v}`] });
        changes.push(`${cand.id}: ${k} ${curCond[k]} → ${v}`);
      } else {
        const anchor = pos.conditionEndLine !== -1 ? pos.conditionEndLine : pos.conditionLine;
        const indent = (pos.conditionIndent ?? pos.indent) + 2;
        edits.push({ start: anchor + 1, end: anchor, lines: [`${" ".repeat(indent)}${k}: ${v}`] });
        changes.push(`${cand.id}: ${k} added (${v})`);
      }
    }
    for (const k of Object.keys(curCond)) {
      if (candCond[k] !== undefined || !pos.conditionKeys[k]) continue;
      edits.push({ start: pos.conditionKeys[k].line, end: pos.conditionKeys[k].line, lines: [] });
      changes.push(`${cand.id}: ${k} removed`);
    }
  }

  // Rules the candidate dropped entirely.
  for (const cur of currentRules) {
    if (candidateRules.some((c) => c.id === cur.id)) continue;
    const pos = indexById.get(cur.id);
    if (!pos) continue;
    let end = pos.endLine;
    while (end > pos.startLine && lines[end].trim() === "") end -= 1;
    edits.push({ start: pos.startLine, end, lines: [] });
    changes.push(`${cur.id}: rule removed`);
  }

  let out = [...lines];
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out.splice(e.start, e.end - e.start + 1, ...e.lines);

  // Rules the candidate added, appended after the last existing rule so
  // the file keeps its shape.
  const added = candidateRules.filter((c) => !currentById.has(c.id));
  if (added.length) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    for (const rule of added) {
      out.push("", ...renderRuleBlock(rule));
      changes.push(`${rule.id}: new rule added`);
    }
  }

  if (index.versionLine !== -1) {
    const m = lines[index.versionLine].match(/^version:\s*(\d+)/);
    const next = m ? Number(m[1]) + 1 : 1;
    // versionLine is above every rule, so no edit shifted it.
    out[index.versionLine] = `version: ${next}`;
    if (changes.length) changes.unshift(`version ${m ? m[1] : "?"} → ${next}`);
  }

  return { text: out.join("\n").replace(/\s*$/, "") + "\n", changes };
}

/** Full re-serialization. Only used as a fallback when the surgical
 *  patch fails its own round-trip check -- a wrong file is worse than an
 *  ugly diff, and the warning says which one you got. */
function toYaml(rules, version) {
  const lines = [`version: ${version}`, "rules:"];
  for (const r of rules) {
    lines.push(...renderRuleBlock(r), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Did the patched text re-parse into the ruleset we backtested? */
function roundTripsTo(text, candidateRules) {
  const reparsed = parseCurrentRuleset(text);
  if (reparsed.length !== candidateRules.length) return false;
  return candidateRules.every((cand) => {
    const got = reparsed.find((r) => r.id === cand.id);
    if (!got) return false;
    const a = cand.condition || {};
    const b = got.condition || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (String(a[k]) !== String(b[k])) return false;
    return String(cand.action ?? "") === String(got.action ?? "") && String(cand.severity ?? "") === String(got.severity ?? "");
  });
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

  const rulesetText = readFileSync(RULESET_PATH, "utf8");
  const nextVersion = Number(rulesetText.match(/^version:\s*(\d+)/m)?.[1] ?? 0) + 1;

  let { text: patchedYaml, changes } = patchRuleset(rulesetText, currentRules, candidateRules);
  if (!roundTripsTo(patchedYaml, candidateRules)) {
    warnings.add(
      "the in-place edit did not re-parse to the ruleset that was backtested, so patched_yaml is a full re-serialization instead -- the diff will touch the whole file and its comments are gone",
    );
    patchedYaml = toYaml(candidateRules, nextVersion);
    changes = ["whole file re-serialized"];
  }

  process.stdout.write(JSON.stringify({
    current,
    candidate,
    delta,
    patched_yaml: patchedYaml,
    patch_summary: changes,
    warnings: [...warnings],
  }));
}

main();
