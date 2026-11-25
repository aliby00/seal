import type { Metadata } from 'next';
import Link from 'next/link';
import { Arch, Wordmark } from './components/brand';
import { LegalLinks } from './components/LegalPage';

export const metadata: Metadata = {
  title: 'Page not found',
};

/** Any address the site does not serve: the brand, one sentence, and the way home. */
export default function NotFound() {
  return (
    <div className="legal">
      <header className="legal-header">
        <Link href="/" className="legal-home" aria-label="SEAL home">
          <Arch className="brand-arch" strips={5} />
          <Wordmark className="brand-word" />
        </Link>
      </header>
      <main className="legal-body">
        <h1>Page not found</h1>
        <p>There is nothing at this address.</p>
        <p>
          To read a Solana token, paste its address on the home page.{' '}
          <Link href="/">Read a token</Link>
        </p>
      </main>
      <footer className="legal-footer">
        <LegalLinks />
        <Link href="/">Back to SEAL</Link>
      </footer>
    </div>
  );
}
