import type { Metadata } from 'next';
import { LegalPage } from '../components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy',
  alternates: { canonical: '/privacy' },
  // A draft awaiting legal review is not offered to search engines.
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="[DATE]">
      <h2>Controller</h2>
      <p>[COMPANY NAME], [COMPANY ADDRESS]. For any question about your data: [CONTACT EMAIL].</p>

      <h2>What we process</h2>
      <ul>
        <li>
          <strong>The token address you submit.</strong> It is public blockchain data, used to run
          the analysis.
        </li>
        <li>
          <strong>Your IP address.</strong> Used to apply the request limits that keep the service
          available, and kept in technical logs by our host.
        </li>
      </ul>
      <p>
        SEAL has no accounts, sets no advertising or tracking cookies, and does not ask for your
        wallet.
      </p>

      <h2>Who receives data</h2>
      <ul>
        <li>Our host, Vercel, which runs the site and keeps technical logs.</li>
        <li>
          Blockchain and market data providers (Robinhood Chain nodes, DexScreener, Blockscout),
          which receive the token address being analysed.
        </li>
        <li>
          Anthropic, which writes the plain-language explanation from the collected public facts.
          Your IP address is not sent to it.
        </li>
      </ul>

      <h2>How long</h2>
      <p>
        Request-limit counters last about a minute. Analysis results may be cached for a few
        minutes. Host logs are kept for [LOG RETENTION PERIOD].
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct or erase your data,
        or to object to its processing. Write to [CONTACT EMAIL]. You may also complain to the data
        protection authority of [JURISDICTION].
      </p>
    </LegalPage>
  );
}
