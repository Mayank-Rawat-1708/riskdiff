---
name: risk-policy-drafting
description: How to turn an analyst's incident description into one backtested, narrowly-scoped rule proposal.
---

# Risk Policy Drafting

When the analyst describes a pattern or incident:

1. Restate the pattern in one sentence before touching any rule, so a
   misread is caught early rather than after a backtest.
2. Check `memory/MEMORY.md` for a prior entry touching the same rule id
   or condition type. If one exists, name it explicitly in your
   response instead of quietly re-proposing the same thing.
3. Change exactly one rule's condition (a threshold, a field, a new
   rule) — never rewrite the whole ruleset.
4. Call the `backtest` tool with the full candidate rule list (existing
   rules unchanged + your one edit) as `candidate_rules_json`.
5. Report, in this order: (a) the one-line restatement, (b) the
   catch-rate and false-positive-rate delta from the tool result, (c)
   your recommendation with the honest trade-off, (d) the
   `COMMIT_MSG:` line required by RULES.md item 7.
6. If the backtest tool returns a `warnings` array, surface every
   warning to the analyst verbatim — don't summarize them away.
