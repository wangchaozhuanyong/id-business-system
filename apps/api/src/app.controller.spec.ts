import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AppController } from './app.controller';
import type { PrismaService } from './common/prisma/prisma.service';
import type { AutoRegistrationService } from './id-business-v2/auto-registration/public-api';

function fixture(environment: string) {
  const registration = { status: vi.fn().mockResolvedValue({ ready: true }) };
  const controller = new AppController(
    { $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) } as unknown as PrismaService,
    { get: () => environment } as unknown as ConfigService,
    registration as unknown as AutoRegistrationService
  );
  return { controller, registration };
}

describe('生产工作区就绪门禁', () => {
  it('主数据库正常但注册服务不可用时，生产就绪检查失败', async () => {
    const { controller, registration } = fixture('production');
    registration.status.mockRejectedValue(new ServiceUnavailableException('自动注册服务未就绪'));
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('生产在数据库与注册模块均正常后保留原健康响应格式', async () => {
    const { controller, registration } = fixture('production');
    await expect(controller.ready()).resolves.toEqual({ status: 'ready', database: 'ok' });
    expect(registration.status).toHaveBeenCalledOnce();
  });

  it('本地没有可选Python环境时，已有业务API仍可就绪', async () => {
    const { controller, registration } = fixture('development');
    await expect(controller.ready()).resolves.toEqual({ status: 'ready', database: 'ok' });
    expect(registration.status).not.toHaveBeenCalled();
  });
});
