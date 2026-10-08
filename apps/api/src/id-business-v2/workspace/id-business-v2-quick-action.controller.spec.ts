import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2QuickActionController } from './id-business-v2-quick-action.controller';
import { IdBusinessV2QuickActionService } from './id-business-v2-quick-action.service';

describe('quick action order route', () => {
  it('routes PUT order to sorting rather than the parameterized reply update', async () => {
    const result = { items: [], hasCustomOrder: false };
    const service = { reorder: vi.fn().mockResolvedValue(result), update: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [IdBusinessV2QuickActionController],
      providers: [{ provide: IdBusinessV2QuickActionService, useValue: service }]
    }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const input = { quickActionIds: [], expectedQuickActionIds: [], initializeOnly: true };
      const response = await fetch(`${await app.getUrl()}/id-business-v2/quick-actions/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual(result);
      expect(service.reorder).toHaveBeenCalledWith(input, undefined, undefined);
      expect(service.update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
