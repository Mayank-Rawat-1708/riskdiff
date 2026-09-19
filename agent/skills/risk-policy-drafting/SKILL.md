---
name: risk-policy-drafting
description: How to turn an analyst's incident description into one backtested, narrowly-scoped rule proposal.
---

# Risk Policy Drafting

## Which rule the report is about

Pick the rule whose **condition** governs the reported behaviour, not
the one whose description sounds closest. Getting this wrong wastes the
analyst's turn, because the backtest will faithfully measure a change
to the wrong rule.

| What the analyst describes | Rule |
|---|---|
| a device that is new, unrecognised, or first seen recently; one large transfer from it | `velocity-new-device` |
| billing country vs IP country; travel, abroad, cross-border, declines while overseas | `geo-mismatch` |
| several transactions from one account close together; bursts, spacing out, staying under a count | `rapid-succession` |

If the report genuinely doesn't match any existing rule's condition
type, say so and propose a new rule rather than bending an existing one
to fit.

## Procedure

Follow this order. Steps 3 and 4 are not optional, and step 4 is not
"write the file however you like".

1. Restate the pattern in one sentence before touching any rule, so a
   misread is caught early rather than after a backtest.
2. Read `memory/MEMORY.md` and look for an entry touching the same rule
   id or condition type. If one exists, name it explicitly — the
   business already has an opinion about it, and re-proposing a
   rejected change without acknowledging it wastes everyone's time.
3. Call the `backtest` tool **before** you write anything and **before**
   you recommend anything, with `candidate_rules_json` set to the full
   rule list — every rule, unchanged, plus your one edit. A
   recommendation written before the numbers arrive is a guess you will
   then be tempted to defend.
4. Write the tool's `patched_yaml` output **verbatim** into
   `rules/active-ruleset.yaml` using the `write` tool. Do not retype the
   file, reformat it, or reconstruct it from memory. `patched_yaml` is
   the live file with only your change applied, so the analyst reviews a
   two-line diff instead of a rewritten file — and it guarantees the
   ruleset that was scored is the ruleset that gets committed.
5. Report, in this order: (a) the one-line restatement, (b) the
   catch-rate and false-positive-rate delta from the tool result, in
   both percentages and counts, (c) your recommendation with the honest
   trade-off, (d) the `COMMIT_MSG:` line required by RULES.md item 7.
6. If the backtest tool returns a `warnings` array, surface every
   warning to the analyst verbatim — don't summarise them away.

## Failure modes to avoid

- Recommending a change you never backtested.
- Backtesting one rule and editing a different one.
- Writing the ruleset by hand instead of using `patched_yaml`.
- Ending without a `COMMIT_MSG:` line.
- Changing two rules because both looked relevant. One per proposal.
