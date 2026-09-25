import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Sonde utilisée par les smoke tests après chaque déploiement.
 * Elle doit rester sans dépendance externe : son rôle est de dire
 * « l'application tourne », pas « les APIs tierces répondent ».
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    env: process.env.SEAL_ENV ?? 'development',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    at: new Date().toISOString(),
  });
}
