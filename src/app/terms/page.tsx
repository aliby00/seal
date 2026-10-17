import type { Metadata } from 'next';
import { CONTACT_URL, LEGAL_UPDATED, LegalPage } from '../components/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of use',
  alternates: { canonical: '/terms' },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated={LEGAL_UPDATED}>
      <h2>Agreement</h2>
      <p>
        By using SEAL (the site at sealauth.dev, its API and its analyses) you accept these terms.
        If you do not accept them, do not use SEAL. Questions go through the{' '}
        <a href={CONTACT_URL}>project&apos;s contact page</a>.
      </p>

      <h2>What SEAL does</h2>
      <p>
        SEAL reads public data about a token on Robinhood Chain — its creator&apos;s past launches,
        how its supply is held, its market — and shows it with an explanation in plain language. It
        gives no score and no advice. Read the <a href="/disclaimer">disclaimer</a> before relying
        on anything shown here.
      </p>

      <h2>Using the service</h2>
      <ul>
        <li>You may use SEAL for your own personal information.</li>
        <li>
          Do not overload the service, get around its request limits, or use it to attack others.
        </li>
        <li>
          Automated or commercial access through the API requires a key issued by SEAL and follows
          the limits attached to it.
        </li>
        <li>We may limit, suspend or stop the service, or a user&apos;s access, at any time.</li>
      </ul>

      <h2>What you may not do</h2>
      <p>Without SEAL&apos;s prior written permission, you may not:</p>
      <ul>
        <li>
          copy, reproduce, republish, resell or redistribute SEAL&apos;s analyses, explanations,
          texts, design, interface or brand, in whole or in substantial part;
        </li>
        <li>
          scrape, crawl or bulk-collect the site or the API, or store their output to build a
          database;
        </li>
        <li>
          copy, modify, host or run SEAL&apos;s source code, or reverse-engineer its method, its
          prompts or its interface;
        </li>
        <li>
          use SEAL, its output or its code to build, train or improve a similar or competing
          service, including a machine-learning model;
        </li>
        <li>
          present SEAL&apos;s work as your own, or use the SEAL name or logo in a way that suggests
          an endorsement.
        </li>
      </ul>
      <p>
        Sharing a link to an analysis, or quoting a short extract with a link back to SEAL, is
        allowed.
      </p>

      <h2>Your responsibility</h2>
      <p>
        You decide what to do with the information. You are responsible for checking it and for the
        consequences of your decisions, including any trade.
      </p>

      <h2>Intellectual property</h2>
      <p>
        The SEAL name and logo, the site&apos;s design and texts, the analyses and explanations it
        produces, and its source code belong to SEAL. All rights are reserved. The source code is
        visible publicly so that anyone can check the method; that visibility grants no right to
        reuse it, as its licence states. Public blockchain data itself belongs to no one.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided &ldquo;as is&rdquo;, without any warranty. To the fullest extent the
        law allows, SEAL is not liable for any loss arising from the use of SEAL, from relying on
        its content, or from the unavailability of the service or of a source.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change; the date above shows the latest version. Continuing to use SEAL
        after a change means you accept the new version. If a clause is found unenforceable, the
        rest still applies.
      </p>
    </LegalPage>
  );
}
