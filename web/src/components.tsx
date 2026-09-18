import type { BacktestResult, ProviderAttempt } from "./api";

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="empty">No change to the ruleset on this branch yet.</div>;
  }
  const lines = diff.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return (
    <div className="diff">
      {lines.map((line, i) => {
        let cls = "ctx";
        if (line.startsWith("@@")) cls = "hunk";
        else if (line.startsWith("+")) cls = "add";
        else if (line.startsWith("-")) cls = "del";
        return (
          <span className={`l ${cls}`} key={i}>
            {line || " "}
          </span>
        );
      })}
    </div>
  );
}

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

/** `goodDirection` says which way is an improvement for this metric, so
 *  the color encodes "better/worse", not just "up/down". A rising
 *  false-positive rate is red even though the number went up. */
function DeltaTag({ value, goodDirection }: { value: number | null; goodDirection: "up" | "down" }) {
  if (value === null || Math.abs(value) < 0.0005) return <div className="delta flat">no change</div>;
  const up = value > 0;
  const isGood = (up && goodDirection === "up") || (!up && goodDirection === "down");
  const cls = isGood ? (up ? "up-good" : "down-good") : up ? "up-bad" : "down-bad";
  return (
    <div className={`delta ${cls}`}>
      {up ? "+" : ""}
      {(value * 100).toFixed(1)}pp
    </div>
  );
}

export function BacktestPanel({ backtest }: { backtest: BacktestResult }) {
  const { current, candidate, delta, warnings } = backtest;
  return (
    <>
      <div className="metrics">
        <div className="metric">
          <div className="label">Fraud caught</div>
          <div className="values">
            <span className="from">{pct(current.catch_rate)}</span>
            <span className="arrow">→</span>
            {pct(candidate.catch_rate)}
          </div>
          <DeltaTag value={delta.catch_rate} goodDirection="up" />
        </div>
        <div className="metric">
          <div className="label">False positives</div>
          <div className="values">
            <span className="from">{pct(current.false_positive_rate)}</span>
            <span className="arrow">→</span>
            {pct(candidate.false_positive_rate)}
          </div>
          <DeltaTag value={delta.false_positive_rate} goodDirection="down" />
        </div>
        <div className="metric">
          <div className="label">Precision</div>
          <div className="values">
            <span className="from">{pct(current.precision)}</span>
            <span className="arrow">→</span>
            {pct(candidate.precision)}
          </div>
          <DeltaTag value={delta.precision} goodDirection="up" />
        </div>
      </div>

      <div className="attempts" style={{ marginTop: 10 }}>
        {current.total_transactions} historical transactions · flagged {current.total_flagged} →{" "}
        {candidate.total_flagged} ({delta.total_flagged >= 0 ? "+" : ""}
        {delta.total_flagged})
      </div>

      {warnings.length > 0 && (
        <div className="warnbox">
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
    </>
  );
}

export function ProviderAttempts({ attempts }: { attempts: ProviderAttempt[] }) {
  if (!attempts?.length) return null;
  const failed = attempts.filter((a) => !a.ok);
  const used = attempts.find((a) => a.ok);
  if (!failed.length && used) {
    return <div className="attempts">model: <span className="used">{used.label}</span></div>;
  }
  return (
    <div className="attempts">
      {failed.map((a, i) => (
        <div key={i} className="failed">
          {a.label} failed — {a.error?.slice(0, 120)}
        </div>
      ))}
      {used && <div className="used">fell back to {used.label}</div>}
    </div>
  );
}
