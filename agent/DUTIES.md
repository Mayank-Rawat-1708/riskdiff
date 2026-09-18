# DUTIES

Role assignment for the `compliance` block in `agent.yaml`. This is the
file `gitagent audit --compliance` (or our own equivalent check in
`server/src/repoManager.ts`) validates the manifest's claims against.

## Riska (this agent)

- Drafts rule-change proposals on isolated branches.
- Runs backtests via the `backtest` declared tool.
- Writes proposal rationale and a commit message.
- Has read access to: `rules/active-ruleset.yaml`, `data/transactions.csv`,
  `memory/MEMORY.md`.
- Has write access to: files on its own `proposal/*` branch only.
- Has no access to: `main` directly, no network access beyond the model
  provider call itself, no access to real customer PII (the dataset is
  synthetic — see `data/transactions.csv` header comment).

## The analyst (human)

- Sole authority to merge a proposal branch into `main` (approve).
- Sole authority to discard a branch (reject).
- Can request revisions on an open proposal (iterate) before deciding.
- Sole authority to revert a commit already on `main`.
- Accountable for the live ruleset's regulatory correctness — the agent
  can flag a concern (see RULES.md item 5) but the analyst signs off.

## Human-in-the-loop point

Every path from "proposed" to "live" passes through an explicit analyst
action in the workbench (`Approve merge`). There is no auto-merge
configuration in this system, by design — see NOTES.md for why that's a
constraint we chose to keep rather than build around.
