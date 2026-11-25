import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { siteUrl } from '@/lib/site';
import './globals.css';
import './hud.css';

const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: 'SEAL — token evidence on Solana', template: '%s · SEAL' },
  description:
    'Paste a Solana token address and read what the chain shows: its mint and the powers it keeps, its creator, its holders, its launch, its liquidity and its market, in plain words. No score.',
  // Declared here, not as app/opengraph-image.png: a file image would override the
  // card a shared reading sets in page.tsx.
  openGraph: {
    type: 'website',
    siteName: 'SEAL',
    url: '/',
    title: 'SEAL — token evidence on Solana',
    description:
      'Who made a Solana token, who holds it, what its mint allows and what its market shows. No score.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SEAL — token evidence on Solana' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SEAL — token evidence on Solana',
    description:
      'Who made a Solana token, who holds it, what its mint allows and what its market shows. No score.',
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1014',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
