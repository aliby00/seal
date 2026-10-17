import type { Metadata } from 'next';
import { LEGAL_UPDATED, LegalPage } from '../components/LegalPage';

export const metadata: Metadata = {
  title: 'Disclaimer',
  alternates: { canonical: '/disclaimer' },
};

export default function DisclaimerPage() {
  return (
    <LegalPage title="Disclaimer" updated={LEGAL_UPDATED}>
      <h2>Not financial advice</h2>
      <p>
        SEAL describes what public sources show about a token. It does not tell you to buy, sell or
        hold anything, and nothing on this site is investment, financial, legal or tax advice.
        Decisions you make are yours alone. Crypto-assets are volatile and you can lose all the
        money you put in.
      </p>

      <h2>No score, no verdict</h2>
      <p>
        SEAL never grades a token and never folds its observations into a single rating. Each figure
        is shown with the source it comes from, so you can weigh it yourself.
      </p>

      <h2>Public on-chain data</h2>
      <p>
        The figures come from public blockchain data on Robinhood Chain and from public market
        sources such as DexScreener and Blockscout. SEAL does not hold private information about
        tokens, their creators or their holders.
      </p>

      <h2>Limits of the sources</h2>
      <ul>
        <li>
          A source can be slow, rate-limited or unavailable. When it is, SEAL says so and shows the
          figure as not measured, never as zero.
        </li>
        <li>Data can be delayed, incomplete or wrong at the source. SEAL does not correct it.</li>
        <li>
          A creator&apos;s history covers launches SEAL can trace on chain. Activity through other
          addresses or other chains is not seen.
        </li>
        <li>SEAL does not audit contract code.</li>
      </ul>

      <h2>Explanations written by a language model</h2>
      <p>
        The plain-language explanation under the figures is written by an artificial intelligence
        model from the collected facts. It can be wrong, incomplete or worded differently from one
        reading to the next. When the model is unavailable, or its text breaks SEAL&apos;s rules, a
        standard explanation is shown instead. Always read it alongside the figures and their
        sources.
      </p>

      <h2>No warranty</h2>
      <p>
        SEAL is provided &ldquo;as is&rdquo;, without any warranty of accuracy, completeness or
        availability. To the fullest extent the law allows, SEAL is not liable for losses resulting
        from the use of this site.
      </p>
    </LegalPage>
  );
}
