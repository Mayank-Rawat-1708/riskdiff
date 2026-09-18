#!/usr/bin/env python3
"""
Generates a synthetic, labeled transaction dataset for RiskDiff's backtest
tool. Entirely fabricated — no real customer or transaction data. Fraud
correlates loosely (not perfectly) with device age, geo mismatch, and
transaction velocity, so a rule tightened along any one of those axes
should show a believable, imperfect precision/recall trade-off rather
than a suspiciously clean 100% catch rate.
"""
import csv
import random
from datetime import datetime, timedelta

random.seed(7)

COUNTRIES = ["IN", "US", "GB", "AE", "SG", "NG", "BR", "DE"]
N = 600
start = datetime(2026, 8, 1)

rows = []
account_recent_counts = {}

for i in range(N):
    tx_id = f"tx_{i:05d}"
    account_id = f"acct_{random.randint(1, 140):04d}"
    ts = start + timedelta(minutes=random.randint(0, 60 * 24 * 30))

    device_age_hours = round(random.choices(
        [random.uniform(0, 6), random.uniform(6, 48), random.uniform(48, 4000)],
        weights=[0.12, 0.13, 0.75]
    )[0], 1)

    billing_country = random.choice(COUNTRIES)
    geo_mismatch = random.random() < 0.10
    ip_country = billing_country if not geo_mismatch else random.choice(
        [c for c in COUNTRIES if c != billing_country]
    )

    amount = round(random.choices(
        [random.uniform(200, 5000), random.uniform(5000, 50000), random.uniform(50000, 400000)],
        weights=[0.55, 0.33, 0.12]
    )[0], 2)

    account_recent_counts.setdefault(account_id, 0)
    tx_count_10min = 1 if random.random() > 0.08 else random.randint(2, 9)

    # Fraud likelihood: soft signal, not a deterministic rule mirror.
    risk_score = 0.0
    if device_age_hours < 24:
        risk_score += 0.35
    if geo_mismatch:
        risk_score += 0.30
    if tx_count_10min >= 5:
        risk_score += 0.25
    if amount > 50000:
        risk_score += 0.15
    risk_score += random.uniform(-0.12, 0.12)  # noise so signals aren't perfect
    is_fraud = random.random() < max(0.01, min(0.92, risk_score))

    rows.append({
        "transaction_id": tx_id,
        "timestamp": ts.isoformat(),
        "account_id": account_id,
        "amount_inr": amount,
        "device_age_hours": device_age_hours,
        "billing_country": billing_country,
        "ip_country": ip_country,
        "account_tx_count_10min": tx_count_10min,
        "is_fraud": int(is_fraud),
    })

rows.sort(key=lambda r: r["timestamp"])

out_path = "/home/claude/riskdiff/agent/data/transactions.csv"
with open(out_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

n_fraud = sum(r["is_fraud"] for r in rows)
print(f"wrote {len(rows)} rows, {n_fraud} labeled fraud ({n_fraud/len(rows):.1%}) to {out_path}")
