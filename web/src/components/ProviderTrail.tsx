import type { ProviderAttempt } from "../api";

/**
 * Which model produced the proposal the analyst is about to merge.
 *
 * When the chain fell back, every attempt is listed with the reason it
 * failed. A silent swap would leave the analyst unable to tell whose
 * judgement is in the diff — a 8B fallback model and a 120B one do not
 * warrant the same amount of trust, and the difference has to be
 * visible at the moment of the decision.
 */
export function ProviderTrail({ attempts }: { attempts?: ProviderAttempt[] }) {
  if (!attempts?.length) return null;
  const failed = attempts.filter((a) => !a.ok);
  const used = attempts.find((a) => a.ok);

  const cost = (a: ProviderAttempt) =>
    [a.ms ? `${(a.ms / 1000).toFixed(1)}s` : null, a.peakInputTokens ? `${(a.peakInputTokens / 1000).toFixed(1)}k tok` : null]
      .filter(Boolean)
      .join(" · ");

  if (!failed.length && used) {
    return (
      <div className="trail-summary">
        <span className="dot ok" />
        <span>drafted by</span>
        <span className="used-model">{used.label}</span>
        <span className="ms">{cost(used)}</span>
      </div>
    );
  }

  return (
    <div className="trail">
      {attempts.map((a, i) => (
        <div className={`trail-row ${a.ok ? "used" : "failed"}`} key={i}>
          <span className={`dot ${a.ok ? "ok" : "bad"}`} />
          <span className="label">{a.label}</span>
          <span className="why" title={a.error}>
            {a.ok ? (failed.length ? "used after fallback" : "used") : a.error}
          </span>
          <span className="ms">{cost(a)}</span>
        </div>
      ))}
    </div>
  );
}
