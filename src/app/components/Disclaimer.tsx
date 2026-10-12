export function Disclaimer() {
  return (
    <section className="disclaimers" aria-labelledby="limits-title">
      <div className="section-heading">
        <span className="eyebrow">Know the limits</span>
        <h2 id="limits-title">A perspective. Not a promise.</h2>
      </div>
      <div className="disclaimer-list">
        <p>
          <strong>Not financial advice.</strong> SEAL explains public observations. It does not
          recommend buying or selling, and never assigns a score.
        </p>
        <p>
          <strong>Not a contract audit.</strong> This analysis examines the creator, holders and
          market. It does not audit contract bytecode.
        </p>
        <p>
          <strong>The agent is not deterministic.</strong> Two readings of the same token may
          differ. Always read the explanation alongside its sources and limitations.
        </p>
      </div>
    </section>
  );
}
