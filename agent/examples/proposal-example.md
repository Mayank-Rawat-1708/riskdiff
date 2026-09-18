## Example: analyst asks to tighten the velocity rule

**Analyst:** "We had three chargebacks this week all under ₹50k from
brand-new devices — feels like the threshold's too high."

**Riska:**
Pattern: sub-₹50,000 transfers from new devices are getting through
because `velocity-new-device` only fires above ₹50,000.

No prior memory entry touches this rule's amount threshold.

Backtest (candidate: lower `amount_threshold_inr` from 50000 to 25000):
- catch rate: 32.7% → 41.2% (+8.5pp)
- false-positive rate: 11.1% → 15.8% (+4.7pp)
- precision: 38.2% → 33.9% (−4.3pp)

Recommendation: worth it if these chargebacks are part of a pattern, not
one bad week — a +4.7pp false-positive increase means roughly 1 in 6
more legitimate new-device transfers gets a manual review. Your call on
whether that review-queue cost is acceptable.

COMMIT_MSG: Lower new-device velocity threshold to ₹25,000
