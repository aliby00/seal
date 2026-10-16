import Link from 'next/link';
import type { ReactNode } from 'react';
import { Arch, Wordmark } from './brand';

/**
 * Shell shared by the legal pages. These texts are drafts: every page says so
 * at the top until a lawyer has read them, and the facts only the company can
 * state (its name, address, governing law) stay as visible placeholders rather
 * than invented ones.
 */
export const LEGAL_LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/disclaimer', label: 'Disclaimer' },
] as const;

export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Legal">
      {LEGAL_LINKS.map((link) => (
        <a key={link.href} href={link.href}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="legal">
      <p className="legal-draft" role="note">
        Draft — pending legal review. This text is not final and may change.
      </p>
      <header className="legal-header">
        <Link href="/" className="legal-home" aria-label="SEAL home">
          <Arch className="brand-arch" strips={5} />
          <Wordmark className="brand-word" />
        </Link>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="legal-updated">Last updated: {updated}</p>
        {children}
      </main>
      <footer className="legal-footer">
        <LegalLinks />
        <Link href="/">Back to SEAL</Link>
      </footer>
    </div>
  );
}
