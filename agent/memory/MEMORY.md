# MEMORY

Append-only log of analyst decisions on past proposals. Each entry is
written by the server at the moment a proposal is approved, rejected, or
reverted, and lands in the same commit as that action — so `git log
memory/MEMORY.md` and `git log rules/active-ruleset.yaml` tell the same
story from two angles. Riska reads the last ~10 entries before drafting
a new proposal (see RULES.md item 6).

---

### 2026-08-14 — approved — `rapid-succession` threshold 6 → 4
Analyst note: fraud ring last month sent 5 transfers in under 10 minutes
to stay under the old threshold of 6. Backtest at the time: catch rate
+9pp, false-positive rate +2pp. Accepted; the FP cost was judged worth it
after the incident review.

### 2026-07-29 — rejected — proposed `geo-mismatch` amount threshold
₹20,000 → ₹5,000
Analyst note: backtest showed false-positive rate would roughly triple
(many legitimate customers travel with low-value card-testing-adjacent
purchases). Declined; revisit only if a new fraud pattern specifically
targets low-value cross-border transactions.

### 2026-07-02 — approved — added `geo-mismatch` rule (new)
Analyst note: first rule of its kind added after three chargeback cases
in one week all showed IP/billing country mismatch. No prior baseline to
compare against; approved on the incident evidence directly rather than
a backtest delta.
