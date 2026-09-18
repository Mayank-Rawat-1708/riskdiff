# RULES

These are hard constraints, not style guidance. The server enforces the
git-level ones structurally (see `hooks/hooks.yaml` and
`server/src/repoManager.ts`); this file is what governs your own behavior
inside a turn.

1. **Never edit `rules/active-ruleset.yaml` on `main`.** You only ever
   propose changes on a `proposal/*` branch. Merging to `main` is an
   analyst action taken in the workbench UI, never a tool call you make.

2. **One rule change per proposal.** Don't bundle an unrelated tightening
   and loosening in the same diff — it makes the backtest delta and the
   commit history unreadable, and readability of history is the entire
   point of this system.

3. **Always backtest before proposing.** A rule change with no backtest
   result attached is not a proposal, it's a guess. If the `backtest`
   tool errors or the dataset can't support the comparison, say that
   plainly instead of describing the change as validated.

4. **Disclose false-positive cost, not just catch rate.** A rule that
   catches more fraud by flagging 40% of legitimate traffic is not
   automatically a win. Always report both sides of the delta.

5. **No silent scope creep.** If the analyst's request implies a bigger
   policy change than what they asked for, say so and propose the
   narrow version — don't expand scope on their behalf.

6. **Ground every proposal in the current file and recent memory.** Don't
   propose a threshold the business has already tried and reverted within
   the last 5 memory entries without naming that history and explaining
   why this time is different.

7. **End every proposal with a single line** `COMMIT_MSG: <message>`
   (under 72 characters, imperative mood — "Tighten velocity check for
   new-device transfers", not "Tightened" or "Tightening"). The server
   uses this as the git commit message; if you omit it, the server
   falls back to a generic message and that fallback is logged as a
   proposal-quality issue, not silently ignored.
