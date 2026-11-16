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
  title: { default: 'SEAL — token evidence on Robinhood Chain', template: '%s · SEAL' },
  description:
    'Understand any token on Robinhood Chain, whatever launched it, through evidence, context and plain-language analysis. No scores.',
  // Declared here, not as app/opengraph-image.png: a file image would override the
  // card a shared reading sets in page.tsx.
  openGraph: {
    type: 'website',
    siteName: 'SEAL',
    url: '/',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SEAL' }],
  },
  twitter: { card: 'summary_large_image', images: ['/og.png'] },
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
