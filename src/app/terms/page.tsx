import type { Metadata } from 'next';
import { LegalPage } from '../components/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of use — SEAL',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="[DATE]">
      <h2>Who we are</h2>
      <p>SEAL is operated by [COMPANY NAME], [COMPANY ADDRESS]. Contact: [CONTACT EMAIL].</p>

      <h2>What SEAL does</h2>
      <p>
        SEAL reads public data about a token on Robinhood Chain — its creator&apos;s past launches,
        how its supply is held, its market — and shows it with an explanation in plain language. It
        gives no score and no advice. Read the <a href="/disclaimer">disclaimer</a> before relying
        on anything shown here.
      </p>

      <h2>Using the service</h2>
      <ul>
        <li>You may use SEAL for your own information.</li>
        <li>
          Do not overload the service, get around its request limits, or use it to attack others.
        </li>
        <li>
          Automated or commercial access through the API requires a key issued by [COMPANY NAME] and
          follows the limits attached to it.
        </li>
        <li>We may limit, suspend or stop the service, or a user&apos;s access, at any time.</li>
      </ul>

      <h2>Your responsibility</h2>
      <p>
        You decide what to do with the information. You are responsible for checking it and for the
        consequences of your decisions, including any trade.
      </p>

      <h2>Intellectual property</h2>
      <p>
        The SEAL name, logo and site design belong to [COMPANY NAME]. The source code is published
        under its own licence, stated in the code repository. Public blockchain data belongs to no
        one.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided &ldquo;as is&rdquo;. To the extent the law allows, [COMPANY NAME] is
        not liable for any loss arising from the use of SEAL or from the unavailability of a source.
      </p>

      <h2>Changes and governing law</h2>
      <p>
        These terms may change; the date above shows the latest version. They are governed by the
        law of [JURISDICTION].
      </p>
    </LegalPage>
  );
}
