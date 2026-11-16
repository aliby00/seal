import type { Metadata } from 'next';
import { getAddress, isAddress } from 'viem';
import { analysisCache } from '@/lib/analysis-cache';
import { cardCache, fromAnalysis, glanceCache, type CachedGlance } from '@/lib/glance-service';
import { AnalyzeForm } from './AnalyzeForm';
import { Disclaimer } from './components/Disclaimer';
import { ImmersiveEntrance } from './components/ImmersiveEntrance';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Metadata never waits on a collection: what is cached, within a second, or nothing. */
const PEEK_MS = 1_000;

async function peek(token: string): Promise<CachedGlance | null> {
  const key = token.toLowerCase();
  const read = async () => {
    const hit = (await cardCache.get(key)) ?? (await glanceCache.get(key));
    if (hit) return hit;
    const analysis = await analysisCache.get(key);
    return analysis ? fromAnalysis(analysis) : null;
  };
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PEEK_MS)),
    ]);
  } catch {
    return null;
  }
}

/**
 * A shared reading (/?token=0x…) shows its own card: the token and the first
 * line of its "In short", drawn by /api/card. Any other visit keeps the site's.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const raw = (await searchParams).token;
  const param = typeof raw === 'string' ? raw.trim() : '';
  if (!isAddress(param)) return { alternates: { canonical: '/' } };
  const token = getAddress(param);
  const known = await peek(token);
  const name = known?.name ?? known?.symbol ?? `${token.slice(0, 6)}…${token.slice(-4)}`;
  const symbol = known?.symbol && known.name ? ` (${known.symbol})` : '';
  const title = `${name}${symbol}, read by SEAL`;
  const description =
    known?.glance.headline ??
    'Who made this token, who holds it and what its market shows, read from Robinhood Chain. No score.';
  const image = { url: `/api/card?token=${token}`, width: 1200, height: 630, alt: title };
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: 'SEAL',
      url: `/?token=${token}`,
      title,
      description,
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default function Home() {
  return (
    <ImmersiveEntrance environment={process.env.SEAL_ENV ?? 'development'}>
      <AnalyzeForm />
      <div className="reading-notes">
        <Disclaimer />
      </div>
    </ImmersiveEntrance>
  );
}
