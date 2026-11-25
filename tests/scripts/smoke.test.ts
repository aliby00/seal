import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * scripts/smoke.mjs against a local stand-in for a deployment: every check
 * passes but the one under test, so the exit code says what that check does.
 */

type Health = Record<string, unknown>;

const HEALTHY: Health = {
  status: 'ok',
  env: 'staging',
  config: { chain: 'solana', solanaNode: 'solana-rpc-url' },
  solana: { node: 'solana-rpc-url', slotOk: true, slot: 473_500_000, ms: 80 },
};
const NODE_DOWN: Health = {
  status: 'degraded',
  env: 'staging',
  config: { chain: 'solana', solanaNode: 'alchemy' },
  solana: { node: 'alchemy', slotOk: false, error: 'refused:403:network', ms: 120 },
};

const ANALYSIS = {
  token: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  explanation:
    'The mint was read on Solana, with its holders and its main market, and each limit is said.',
  completeness: 'partial',
  sources: [{ name: 'solana-rpc', fetchedAt: '2026-11-25T10:00:00.000Z' }],
  collectedAt: '2026-11-25T10:00:00.000Z',
  offline: true,
  costUsd: 0,
};

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

/** A deployment whose /api/health answers each probe in turn from `answers` (the last one repeats). */
async function deployment(answers: { status: number; body: Health }[]) {
  let probes = 0;
  server = createServer((req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/') return send(200, '<title>SEAL</title>', 'text/html');
    if (req.url === '/api/health') {
      const answer = answers[Math.min(probes, answers.length - 1)]!;
      probes += 1;
      return send(answer.status, answer.body);
    }
    if (req.url === '/api/analyze') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const { token } = JSON.parse(raw) as { token: string };
        if (token === ANALYSIS.token) send(200, ANALYSIS);
        else send(400, { error: 'not a Solana address' });
      });
      return;
    }
    return send(404, 'not found', 'text/plain');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, probes: () => probes };
}

function smoke(url: string, env = 'staging') {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/smoke.mjs', url, env], {
      env: { ...process.env, SMOKE_HEALTH_RETRY_MS: '10' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('scripts/smoke.mjs, /api/health', () => {
  it('passes a deployment whose Solana node answers', async () => {
    const { url } = await deployment([{ status: 200, body: HEALTHY }]);
    const { code, out } = await smoke(url);
    expect(out).toContain('tous les smoke tests passent');
    expect(code).toBe(0);
  });

  it('fails a deployment whose Solana node does not answer, after a few tries', async () => {
    const { url, probes } = await deployment([{ status: 503, body: NODE_DOWN }]);
    const { code, out } = await smoke(url);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+\/api\/health/);
    expect(out).toContain('refused:403:network');
    expect(probes()).toBe(3);
  });

  it('passes when the node answers again on a later try', async () => {
    const { url } = await deployment([
      { status: 503, body: NODE_DOWN },
      { status: 200, body: HEALTHY },
    ]);
    expect((await smoke(url)).code).toBe(0);
  });

  it('fails a deployment that does not read Solana, or says nothing of its node', async () => {
    const evm = { status: 'ok', env: 'staging', config: { rpc: 'custom' } };
    const { url } = await deployment([{ status: 200, body: evm }]);
    const { code, out } = await smoke(url);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+\/api\/health/);
  });
});
