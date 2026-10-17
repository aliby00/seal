import Link from 'next/link';
import type { ReactNode } from 'react';
import { Arch, Wordmark } from './brand';

/** Shell shared by the legal pages. */

/** The date shown on every legal page: bump it whenever one of them changes. */
export const LEGAL_UPDATED = 'October 17, 2026';

/** Where questions about the terms or about data go. */
export const CONTACT_URL = 'https://github.com/aliby00/seal/issues';

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
