import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2SystemMonitoringController } from './id-business-v2-system-monitoring.controller';

describe('IdBusinessV2SystemMonitoringController', () => {
  it('exposes the read-only overview service', async () => {
    const overview = vi.fn().mockResolvedValue({ overallStatus: 'healthy' });
    const controller = new IdBusinessV2SystemMonitoringController({ overview } as never);

    await controller.overview();

    expect(overview).toHaveBeenCalledWith();
  });
});
