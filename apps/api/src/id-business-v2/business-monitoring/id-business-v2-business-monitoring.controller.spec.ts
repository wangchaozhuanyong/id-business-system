import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BusinessMonitoringController } from './id-business-v2-business-monitoring.controller';

describe('IdBusinessV2BusinessMonitoringController', () => {
  it('passes only supported list filters to the service', async () => {
    const list = vi.fn().mockResolvedValue({ result: { items: [] } });
    const controller = new IdBusinessV2BusinessMonitoringController({ list } as never);

    await controller.list('2', '50', 'warning', 'renewal');

    expect(list).toHaveBeenCalledWith({
      page: '2',
      pageSize: '50',
      severity: 'warning',
      category: 'renewal'
    });
  });
});
