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
  alternates: { canonical: '/' },
  title: 'SEAL',
  description:
    'Understand pons tokens on Robinhood Chain through evidence, context and plain-language analysis. No scores.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
