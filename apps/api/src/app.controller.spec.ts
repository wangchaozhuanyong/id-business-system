import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from './app.controller';
import type { PrismaService } from './common/prisma/prisma.service';

afterEach(() => vi.restoreAllMocks());

describe('API readiness after registration retirement', () => {
  it('is ready with its database and has no registration runtime dependency', async () => {
    const query = vi.fn().mockResolvedValue([{ result: 1 }]);
    const controller = new AppController({ $queryRaw: query } as unknown as PrismaService);
    await expect(controller.ready()).resolves.toEqual({ status: 'ready', database: 'ok' });
    expect(query).toHaveBeenCalledOnce();
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('still rejects database failure while the process remains live', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new AppController({
      $queryRaw: vi.fn().mockRejectedValue(new Error('fixture database unavailable'))
    } as unknown as PrismaService);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
