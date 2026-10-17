import type { Metadata } from 'next';
import { CONTACT_URL, LEGAL_UPDATED, LegalPage } from '../components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated={LEGAL_UPDATED}>
      <h2>In short</h2>
      <p>
        SEAL has no accounts, sets no advertising or tracking cookies, and never asks for your
        wallet. It processes the least it can to run.
      </p>

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
      <p>We do not sell data and do not share it for advertising.</p>

      <h2>The browser extension</h2>
      <p>
        The SEAL browser extension shows the same short summary on DexScreener, Blockscout and the
        pons launchpad. When it finds a Robinhood Chain token on the page you are viewing, it sends
        that token&apos;s address (or the trading pair&apos;s address on DexScreener) to
        sealauth.dev, and nothing else: not the page you are on, not your browsing history, not a
        cookie or an identifier. Answers are kept in your browser for five minutes, then forgotten.
        The only setting it stores is the list of sites where you switched it off, kept by your
        browser.
      </p>

      <h2>How long</h2>
      <p>
        Request-limit counters last about a minute. Analysis results, which hold only public data,
        may be cached for a few minutes. Host logs are kept for a short period set by Vercel, then
        deleted.
      </p>

      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct or erase your data,
        or to object to its processing. Since SEAL keeps no account and no profile, there is usually
        nothing tied to you to return; you can still ask through the{' '}
        <a href={CONTACT_URL}>project&apos;s contact page</a>.
      </p>
    </LegalPage>
  );
}
