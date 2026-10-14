import { expect, it } from 'vitest';
import { createRpcClient } from '../../src/lib/chain/rpc';
import { collect } from '../../src/lib/collect';

/**
 * Balances rebuilt from transfers must equal what the token itself reports.
 * Only with SEAL_LIVE=1.
 */
it.skipIf(process.env.SEAL_LIVE !== '1')(
  'rebuilt balances match balanceOf',
  { timeout: 120_000 },
  async () => {
    const token = '0x10e848f9d5073d670201b111f1ba3d1c5be6f18b';
    const report = await collect(token);
    expect(report.holders.completeness).toBe('full');
    const rpc = createRpcClient();
    const top = report.holders.data.top.slice(0, 5);
    const out = await rpc.callBatch<string>(
      top.map((h) => ({
        method: 'eth_call',
        params: [
          { to: token, data: `0x70a08231${h.address.slice(2).padStart(64, '0')}` },
          'latest',
        ],
      })),
    );
    top.forEach((h, i) => {
      const onchain = out[i]?.ok ? BigInt(out[i].value).toString() : 'unread';
      process.stderr.write(`${h.kind} ${h.address} rebuilt=${h.balance} onchain=${onchain}\n`);
      expect(h.balance).toBe(onchain);
    });
  },
);
