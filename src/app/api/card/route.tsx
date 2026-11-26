import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { isSolanaAddress, shortAddress } from '@/lib/solana/address';
import { analysisCache } from '@/lib/analysis-cache';
import { cachedGlance, cardCache, fromAnalysis, glanceOf } from '@/lib/glance-service';
import type { GlanceItem, GlanceTone } from '@/lib/glance';
import { allowShared, clientKey, COLLECT_LIMIT, type RateLimit } from '@/lib/guard';
import { log } from '@/lib/logger';
import { SealError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/card?token=<mint>
 *
 * The image a shared reading shows on X, Telegram or Discord: the token, the
 * first line of its "In short" and the next two, as the report states them.
 * Never a score: the same sentences as the page, nothing added.
 *
 * Served from the analysis the sharer has just run (cached) whenever possible.
 * A token nobody read recently is collected once, within a few seconds; past
 * that, or past the rate limit, the card names the token without findings.
 */

const SIZE = { width: 1200, height: 630 };
/** Link crawlers give up after a few seconds: a plain card beats no card. */
const CARD_WAIT_MS = 8_000;
/** Crawlers of several apps fetch the same card; a person never needs more. */
const CARD_LIMIT: RateLimit = { capacity: 20, perMinute: 20 };
/**
 * As long as a young token's reading is kept (analysis-cache.ts): the card a
 * crawler keeps longer showed other numbers than the page (POPCAT, 26/11/2026).
 */
const CARD_CACHE = 'public, max-age=180, s-maxage=180';

const INK = '#05080b';
const TEXT = '#eef2f4';
const DIM = '#9aa6ae';
const FAINT = '#7d8992';
const ACCENT = '#ff8a2a';
const TONE: Record<GlanceTone, { color: string; label: string }> = {
  attention: { color: '#ffc857', label: 'Worth attention' },
  neutral: { color: '#7fb6ff', label: 'Context' },
  reassuring: { color: '#5fe3c4', label: 'Reassuring' },
};

type Font = { name: string; data: Buffer; weight: 500 | 700; style: 'normal' };
let fonts: Promise<Font[]> | null = null;

function loadFonts(): Promise<Font[]> {
  const dir = join(process.cwd(), 'src/app/api/card/fonts');
  const file = (name: string) => readFile(join(dir, name));
  fonts ??= Promise.all([
    file('space-grotesk-latin-700-normal.ttf'),
    file('space-grotesk-latin-500-normal.ttf'),
    file('jetbrains-mono-latin-500-normal.ttf'),
  ])
    .then(([bold, medium, mono]) => [
      { name: 'Grotesk', data: bold, weight: 700 as const, style: 'normal' as const },
      { name: 'Grotesk', data: medium, weight: 500 as const, style: 'normal' as const },
      { name: 'Mono', data: mono, weight: 500 as const, style: 'normal' as const },
    ])
    .catch((error: unknown) => {
      fonts = null;
      throw error;
    });
  return fonts;
}

/** Cut at a word, so a long sentence ends cleanly inside its box. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).replace(/[\s,;:.]+$/, '')}…`;
}

/** The SEAL arch: the scanner's frame and its curtain of strips. */
function Arch({ size }: { size: number }) {
  const strips = Array.from({ length: 14 }, (_, i) => {
    const pitch = (100 - 22 - 22) / 14;
    const w = pitch * 0.72;
    const x = 22 + pitch * i + (pitch - w) / 2;
    const dx = x + w / 2 - 50;
    const top = 46 - Math.sqrt(Math.max(0, 31 * 31 - dx * dx)) + 4;
    return { x, w, top, h: 86 - top };
  });
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {strips.map((s, i) => (
        <rect key={i} x={s.x} y={s.top} width={s.w} height={s.h} rx={s.w / 2} fill={ACCENT} />
      ))}
      <path d="M11 93 V46 A39 39 0 0 1 89 46 V93 H81 V46 A31 31 0 0 0 19 46 V93 Z" fill={ACCENT} />
    </svg>
  );
}

function Pill({ tone }: { tone: GlanceTone }) {
  const { color, label } = TONE[tone];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        borderRadius: 999,
        border: `1.5px solid ${color}66`,
        background: `${color}1a`,
        color,
        fontSize: 20,
        fontFamily: 'Grotesk',
        fontWeight: 500,
      }}
    >
      <div style={{ width: 9, height: 9, borderRadius: 9, background: color }} />
      {label}
    </div>
  );
}

type CardData = {
  /** `null`: the site's own card, for an address that holds no token. */
  token: string | null;
  name: string | null;
  symbol: string | null;
  items: GlanceItem[];
};

function Card({ data }: { data: CardData }) {
  const [lead, ...rest] = data.items;
  const title = data.token
    ? (data.name ?? data.symbol ?? 'A token on Solana')
    : 'Paste a token. Read its story.';
  const nameSize = title.length > 18 ? 54 : 68;
  const tone = lead ? TONE[lead.tone].color : ACCENT;
  // A wide figure ("0.4990 SOL") goes above its sentence, which keeps the full width.
  const stacked = Boolean(lead?.figure && lead.figure.length > 6);
  return (
    <div
      style={{
        ...SIZE,
        display: 'flex',
        flexDirection: 'column',
        padding: '44px 64px 40px',
        background: `radial-gradient(900px 520px at 0% 0%, ${tone}24, transparent 70%), radial-gradient(700px 480px at 100% 100%, ${ACCENT}1c, transparent 70%), ${INK}`,
        color: TEXT,
        fontFamily: 'Grotesk',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Arch size={46} />
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 6 }}>SEAL</div>
        </div>
        <div style={{ fontFamily: 'Mono', fontSize: 18, color: FAINT, letterSpacing: 3 }}>
          READING · SOLANA
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 34 }}>
        <div style={{ fontSize: nameSize, fontWeight: 700, letterSpacing: -2, lineHeight: 1 }}>
          {clip(title, 30)}
        </div>
        {data.symbol && data.name && (
          <div
            style={{
              display: 'flex',
              padding: '6px 14px',
              borderRadius: 999,
              border: `1.5px solid ${ACCENT}99`,
              color: ACCENT,
              fontFamily: 'Mono',
              fontSize: 22,
              letterSpacing: 2,
            }}
          >
            {clip(data.symbol, 12)}
          </div>
        )}
      </div>
      <div style={{ fontFamily: 'Mono', fontSize: 20, color: FAINT, marginTop: 12 }}>
        {data.token ? `${shortAddress(data.token)} · Solana` : 'Token research on Solana'}
      </div>

      {lead ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 34,
            marginBottom: 24,
            flexGrow: 1,
          }}
        >
          <div style={{ display: 'flex' }}>
            <Pill tone={lead.tone} />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: stacked ? 'column' : 'row',
              alignItems: stacked ? 'flex-start' : 'center',
              gap: stacked ? 8 : 30,
              marginTop: 20,
            }}
          >
            {lead.figure && (
              <div
                style={{
                  fontSize: stacked ? 76 : 104,
                  fontWeight: 700,
                  letterSpacing: -4,
                  lineHeight: 1,
                  color: tone,
                }}
              >
                {lead.figure}
              </div>
            )}
            <div
              style={{
                display: 'flex',
                flex: 1,
                fontSize: stacked ? 30 : 34,
                lineHeight: 1.22,
                fontWeight: 500,
              }}
            >
              {/* Two lines at most: the card is a summary, the page has the rest. */}
              {clip(lead.title, stacked ? 110 : lead.figure ? 90 : 120)}
            </div>
          </div>
          {/* A long or stacked first line leaves room for one more, not two. */}
          {rest.slice(0, stacked || lead.title.length > 80 ? 1 : 2).map((item) => (
            <div
              key={item.id}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginTop: 14 }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  marginTop: 11,
                  borderRadius: 10,
                  background: TONE[item.tone].color,
                  flexShrink: 0,
                }}
              />
              <div style={{ display: 'flex', fontSize: 23, color: DIM, lineHeight: 1.3 }}>
                {clip(item.title, 80)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexGrow: 1,
            alignItems: 'center',
            fontSize: 40,
            fontWeight: 500,
            color: DIM,
          }}
        >
          Who made it, who holds it, what its market shows, read on Solana.
        </div>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid rgba(255,255,255,0.1)',
          paddingTop: 20,
          fontSize: 21,
        }}
      >
        <div style={{ color: TEXT, fontWeight: 700 }}>sealauth.dev</div>
        {/* The market figures come from DexScreener, not from the chain. */}
        <div style={{ color: FAINT }}>No score. Only what Solana and its markets show.</div>
      </div>
    </div>
  );
}

/** The site's card: no address, no finding. */
const SITE_CARD: CardData = { token: null, name: null, symbol: null, items: [] };

async function render(data: CardData, cache: string): Promise<Response> {
  const image = new ImageResponse(<Card data={data} />, { ...SIZE, fonts: await loadFonts() });
  image.headers.set('Cache-Control', cache);
  return image;
}

export async function GET(request: Request): Promise<Response> {
  const param = new URL(request.url).searchParams.get('token')?.trim() ?? '';
  if (!isSolanaAddress(param)) return new Response('Invalid token address', { status: 400 });
  const token = param;
  const plain: CardData = { token, name: null, symbol: null, items: [] };
  // Short-lived: the next crawler may find the reading done.
  const retry = 'public, max-age=60, s-maxage=60';
  // One caller past its limit: the CDN must not serve that empty card to everyone.
  const limited = 'private, no-store';

  const caller = clientKey(request);
  if (!(await allowShared(`card:${caller}`, CARD_LIMIT))) return render(plain, limited);

  try {
    // The analysis the page shows first, so the card and the page give the
    // same numbers (POPCAT: $590.8k on the card, $596.2k on the page,
    // 26/11/2026); then the card of the last analysis served, kept longer;
    // then a glance. No collection for those.
    const analysis = await analysisCache.get(token).catch(() => null);
    const known =
      (analysis ? fromAnalysis(analysis) : null) ??
      (await cardCache.get(token).catch(() => null)) ??
      (await cachedGlance(token).catch(() => null));
    // Not in a cache: a full collection, counted with the address's others (analyze, glance).
    if (!known && !(await allowShared(`collect:${caller}`, COLLECT_LIMIT))) {
      return render(plain, limited);
    }
    const glance =
      known ??
      (await Promise.race([
        glanceOf(token),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CARD_WAIT_MS)),
      ]));
    if (!glance) return render(plain, retry);
    const items = glance.glance.items.filter((item) => !item.unread);
    return render({ token, name: glance.name, symbol: glance.symbol, items }, CARD_CACHE);
  } catch (error) {
    // A wallet or any address that holds no token gets the site's own card,
    // never one naming the address: nobody can post a "read by SEAL" card
    // for it (audit, 26/11/2026).
    if (
      error instanceof SealError &&
      (error.kind === 'not-found' || error.kind === 'not-fungible')
    ) {
      return render(SITE_CARD, 'public, max-age=300, s-maxage=300');
    }
    log.warn('carte de partage sans lecture', { error: String(error) });
    return render(plain, retry);
  }
}
