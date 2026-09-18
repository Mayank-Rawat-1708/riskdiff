import type { BacktestResult } from "../api";
import { pct, pp, signed } from "../lib/format";

/** `goodDirection` says which way is an improvement for this metric, so
 *  colour encodes better/worse rather than up/down. A rising
 *  false-positive rate is red even though the number went up. */
function Delta({ value, goodDirection }: { value: number | null; goodDirection: "up" | "down" }) {
  if (value === null || Math.abs(value) < 0.0005) return <div className="m-delta flat">no change</div>;
  const better = value > 0 === (goodDirection === "up");
  return <div className={`m-delta ${better ? "better" : "worse"}`}>{pp(value)}</div>;
}

function Metric({
  label,
  from,
  to,
  delta,
  goodDirection,
  counts,
}: {
  label: string;
  from: number | null;
  to: number | null;
  delta: number | null;
  goodDirection: "up" | "down";
  counts: string;
}) {
  return (
    <div className="metric">
      <div className="m-label">{label}</div>
      <div className="m-values">
        <span className="m-from">{pct(from)}</span>
        <span className="m-arrow" aria-hidden="true">
          →
        </span>
        <span className="m-to">{pct(to)}</span>
      </div>
      <Delta value={delta} goodDirection={goodDirection} />
      <div className="m-counts">{counts}</div>
    </div>
  );
}

export function Backtest({ backtest, ruleIds }: { backtest: BacktestResult; ruleIds: string[] }) {
  const { current, candidate, delta, warnings, patch_summary: patch } = backtest;

  const frauds = current.true_positives + current.false_negatives;
  const catchDelta = candidate.true_positives - current.true_positives;
  const fpDelta = candidate.false_positives - current.false_positives;

  const rules = [...new Set([...ruleIds, ...Object.keys(current.flags_per_rule ?? {}), ...Object.keys(candidate.flags_per_rule ?? {})])];
  const peak = Math.max(1, ...rules.map((r) => Math.max(current.flags_per_rule?.[r] ?? 0, candidate.flags_per_rule?.[r] ?? 0)));

  return (
    <>
      <div className="metrics">
        <Metric
          label="Fraud caught"
          from={current.catch_rate}
          to={candidate.catch_rate}
          delta={delta.catch_rate}
          goodDirection="up"
          counts={`${candidate.true_positives} of ${frauds} known frauds`}
        />
        <Metric
          label="False positives"
          from={current.false_positive_rate}
          to={candidate.false_positive_rate}
          delta={delta.false_positive_rate}
          goodDirection="down"
          counts={`${candidate.false_positives} clean transactions flagged`}
        />
        <Metric
          label="Precision"
          from={current.precision}
          to={candidate.precision}
          delta={delta.precision}
          goodDirection="up"
          counts={`${candidate.total_flagged} sent to review`}
        />
      </div>

      {/* The trade in the unit an analyst actually argues in: catches
          bought, review-queue load paid. */}
      <div className="tradeoff">
        {catchDelta === 0 && fpDelta === 0 ? (
          <>This change flags the same transactions as the live ruleset — no measurable effect on either side.</>
        ) : (
          <>
            Against {current.total_transactions} historical transactions, this catches{" "}
            <b className={catchDelta > 0 ? "gain" : catchDelta < 0 ? "cost" : ""}>{signed(catchDelta)}</b>{" "}
            {Math.abs(catchDelta) === 1 ? "fraud" : "frauds"} and sends{" "}
            <b className={fpDelta > 0 ? "cost" : fpDelta < 0 ? "gain" : ""}>{signed(fpDelta)}</b> legitimate{" "}
            {Math.abs(fpDelta) === 1 ? "transaction" : "transactions"} to manual review
            {catchDelta > 0 && fpDelta > 0 ? (
              <>
                {" "}
                — about <b>{(fpDelta / catchDelta).toFixed(1)}</b> false positives per additional catch.
              </>
            ) : (
              "."
            )}
          </>
        )}
      </div>

      {patch?.length > 0 && (
        <div className="ev-section">
          <div className="ev-head">
            <h3>What the patch moves</h3>
          </div>
          <div className="trail">
            {patch.map((c, i) => (
              <div className="trail-row" key={i}>
                <span className="label">{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ev-section">
        <div className="ev-head">
          <h3>Flags contributed per rule</h3>
          <span className="note">live → candidate</span>
        </div>
        <table className="perrule">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Live</th>
              <th>Candidate</th>
              <th>Δ</th>
              <th className="bar" />
            </tr>
          </thead>
          <tbody>
            {rules.map((id) => {
              const a = current.flags_per_rule?.[id] ?? 0;
              const b = candidate.flags_per_rule?.[id] ?? 0;
              const d = b - a;
              return (
                <tr key={id}>
                  <td>{id}</td>
                  <td>{current.flags_per_rule?.[id] === undefined ? "—" : a}</td>
                  <td>{candidate.flags_per_rule?.[id] === undefined ? "—" : b}</td>
                  <td className={`d ${d > 0 ? "up" : d < 0 ? "down" : "flat"}`}>{d === 0 ? "—" : signed(d)}</td>
                  <td className="bar">
                    <span className={d > 0 ? "grew" : ""} style={{ width: `${Math.round((b / peak) * 100)}%` }} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {warnings?.length > 0 && (
        <div className="ev-section">
          {warnings.map((w, i) => (
            <div className="notice pending" key={i}>
              <div className="body">
                <strong>The backtest qualified this number</strong>
                {w}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
