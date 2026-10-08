import { describe, expect, it, vi } from 'vitest';
import { startServerRecheck } from './recharge-server-recheck';

const operator = { id: 'synthetic-owner', roles: ['admin'], permissions: [] };

describe('服务器充值入口退役', () => {
  it.each(['check', 'quote', 'prepare', 'flow', 'server', 'recheck'])(
    '旧 %s 请求在读取凭据或代理之前被拒绝',
    async (action) => {
      const deps = {
        repository: { findJob: vi.fn() },
        transactions: { execute: vi.fn() },
        proxies: { forCharge: vi.fn() },
        bankAccounts: { savedLogin: vi.fn() }
      };
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      try {
        await expect(startServerRecheck({ action }, operator as never, deps)).rejects.toThrow(
          '服务器充值复查已停用'
        );
        expect(deps.repository.findJob).not.toHaveBeenCalled();
        expect(deps.transactions.execute).not.toHaveBeenCalled();
        expect(deps.proxies.forCharge).not.toHaveBeenCalled();
        expect(deps.bankAccounts.savedLogin).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );
});
