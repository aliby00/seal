const chapters = [
  {
    id: 'creator',
    weather: 'night',
    number: '01',
    provider: 'Robinhood RPC',
    title: 'Trace the origin.',
    text: 'Every launch has a history. SEAL reads the creator’s previous launches and their outcomes within the available block range.',
    detail: 'What came before — and what the available history cannot tell us.',
    graphic: 'orbit',
  },
  {
    id: 'holders',
    weather: 'day',
    number: '02',
    provider: 'Blockscout',
    title: 'Look beneath the surface.',
    text: 'Ownership is more than a list of addresses. SEAL examines supply distribution, separating liquidity pools and burn addresses from holders.',
    detail: 'The structure of ownership, with coverage limits made explicit.',
    graphic: 'layers',
  },
  {
    id: 'market',
    weather: 'rain',
    number: '03',
    provider: 'DexScreener',
    title: 'Read through the noise.',
    text: 'Liquidity, volume and transactions each tell part of the story. SEAL brings them together and explains where they contradict other observations.',
    detail: 'Market activity in context. An explanation, never a verdict.',
    graphic: 'waves',
  },
] as const;

function TechnicalGraphic({ kind }: { kind: string }) {
  return (
    <div className={`technical-art art-${kind}`} aria-hidden="true">
      <div className="art-halo" />
      {kind === 'orbit' && (
        <svg className="orbital-globe" viewBox="0 0 320 320" fill="none">
          <circle cx="160" cy="160" r="130" className="globe-outline" />
          {[0, 1, 2].map((i) => (
            <g key={i} className={`orbital-meridian meridian-${i}`}>
              <circle cx="160" cy="160" r="130" />
              <circle cx="68" cy="68" r="3" className="orbit-point" />
              <circle cx="252" cy="252" r="3" className="orbit-point" />
            </g>
          ))}
        </svg>
      )}
      {kind === 'layers' && (
        <div className="layer-assembly">
          {[0, 1, 2, 3, 4].map((i) => (
            <div className={`structure-layer layer-${i}`} key={i}>
              <span />
            </div>
          ))}
        </div>
      )}
      {kind === 'waves' && (
        <svg className="signal-field" viewBox="0 0 400 340" fill="none">
          {Array.from({ length: 12 }, (_, i) => (
            <path
              key={i}
              d={`M 30 ${80 + i * 14} C 120 ${-10 + i * 20}, 190 ${350 - i * 12}, 370 ${75 + i * 15}`}
            />
          ))}
        </svg>
      )}
      <div className="art-footnote">
        SEAL / {kind === 'orbit' ? 'ORIGIN' : kind === 'layers' ? 'STRUCTURE' : 'CONTEXT'}
      </div>
    </div>
  );
}

export function SourceStudy() {
  return (
    <section id="method" className="weather-story" aria-labelledby="perspectives-title">
      <div className="story-heading">
        <p className="eyebrow">Behind the analysis</p>
        <h2 id="perspectives-title">A change in perspective.</h2>
        <p>Follow the evidence. Keep the uncertainty in view.</p>
      </div>
      {chapters.map((chapter) => (
        <section
          key={chapter.id}
          id={`chapter-${chapter.id}`}
          className={`weather-chapter chapter-${chapter.weather}`}
          data-weather={chapter.weather}
          aria-labelledby={`title-${chapter.id}`}
        >
          <div className="chapter-copy">
            <span className="chapter-number">
              {chapter.number} / {chapter.id.toUpperCase()}
            </span>
            <p className="chapter-provider">{chapter.provider}</p>
            <h3 id={`title-${chapter.id}`}>{chapter.title}</h3>
            <p>{chapter.text}</p>
            <p className="chapter-detail">{chapter.detail}</p>
            <a href="#analysis">
              Analyze a token <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div className="chapter-art">
            <TechnicalGraphic kind={chapter.graphic} />
            <p>Method illustration · no token data displayed</p>
          </div>
        </section>
      ))}
    </section>
  );
}
