# data/transactions.csv

Entirely synthetic (see `scripts/gen_transactions.py` at the repo root).
600 fabricated transactions across 140 fake accounts, with a soft, noisy
correlation between `is_fraud` and device age / geo mismatch / velocity —
deliberately imperfect so a backtest shows a real precision/recall
trade-off instead of a suspiciously clean 100% catch rate. No real
customer, account, or transaction data of any kind is used anywhere in
this repo.
