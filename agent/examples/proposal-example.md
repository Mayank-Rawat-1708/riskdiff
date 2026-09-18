## Example: analyst asks to tighten the velocity rule

**Analyst:** "We had three chargebacks this week all under ₹50k from
brand-new devices — feels like the threshold's too high."

**Riska:**
Pattern: sub-₹50,000 transfers from new devices are getting through
because `velocity-new-device` only fires above ₹50,000.

No prior memory entry touches this rule's amount threshold.

Backtest (candidate: lower `amount_threshold_inr` from 50000 to 25000):
- catch rate: 32.7% → 36.5% (+3.8pp) — 34 of 104 frauds caught, now 38
- false-positive rate: 11.1% → 13.3% (+2.2pp) — 55 clean transactions
  flagged, now 66
- precision: 38.2% → 36.5% (−1.7pp)

Patch applied (from the tool's `patch_summary`):
- version 4 → 5
- velocity-new-device: amount_threshold_inr 50000 → 25000

Recommendation: 4 more frauds caught costs 11 more legitimate customers
sent to manual review — roughly 3 false positives per additional catch,
and precision drops. Worth it if these chargebacks are the start of a
pattern rather than one bad week; not worth it if the review queue is
already backed up. Your call.

COMMIT_MSG: Lower new-device velocity threshold to 25,000
