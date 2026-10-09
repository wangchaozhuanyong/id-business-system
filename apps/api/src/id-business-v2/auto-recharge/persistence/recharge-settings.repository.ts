import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { ACCOUNT_COPY_SETTINGS_OWNER_ID, accountCopySuffix } from '../account-copy-settings';

export const BIT_ORDER_PRICING_SETTINGS_OWNER_ID = '__bit_order_pricing_settings__';

@Injectable()
export class RechargeSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(ownerId: string) {
    return this.prisma.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
  }

  findInTransaction(tx: V2CommandTransaction, ownerId: string) {
    return tx.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
  }

  findOrderPricing(tx?: V2CommandTransaction) {
    return (tx ?? this.prisma).idBusinessV2RechargeBrowserSetting.findUnique({
      where: { ownerId: BIT_ORDER_PRICING_SETTINGS_OWNER_ID },
      select: { browserOptions: true, updatedAt: true }
    });
  }

  async compareAndSetOrderPricing(
    tx: V2CommandTransaction,
    expectedUpdatedAt: Date | null,
    browserOptions: Prisma.InputJsonValue
  ) {
    const ownerId = BIT_ORDER_PRICING_SETTINGS_OWNER_ID;
    const updatedAt = new Date(Math.max(Date.now(), (expectedUpdatedAt?.getTime() ?? 0) + 1));
    const result =
      expectedUpdatedAt === null
        ? await tx.idBusinessV2RechargeBrowserSetting.createMany({
            data: [{ ownerId, browserOptions, updatedAt }],
            skipDuplicates: true
          })
        : await tx.idBusinessV2RechargeBrowserSetting.updateMany({
            where: { ownerId, updatedAt: expectedUpdatedAt },
            data: { browserOptions, updatedAt }
          });
    return result.count === 1 ? this.findOrderPricing(tx) : null;
  }

  async findAccountCopySuffix(tx?: V2CommandTransaction) {
    const settings = (tx ?? this.prisma).idBusinessV2RechargeBrowserSetting;
    const shared = await settings.findUnique({
      where: { ownerId: ACCOUNT_COPY_SETTINGS_OWNER_ID },
      select: { browserOptions: true }
    });
    if (shared) return accountCopySuffix(shared.browserOptions);

    // 兼容共享设置启用前的已保存后缀，不读取连接密钥或修改个人配置。
    const legacy = await settings.findMany({
      where: { ownerId: { not: ACCOUNT_COPY_SETTINGS_OWNER_ID } },
      select: { browserOptions: true },
      orderBy: [{ updatedAt: 'desc' }, { ownerId: 'asc' }]
    });
    return legacy.map((row) => accountCopySuffix(row.browserOptions)).find(Boolean) ?? '';
  }

  upsert(
    tx: V2CommandTransaction,
    ownerId: string,
    data: Omit<Prisma.IdBusinessV2RechargeBrowserSettingUncheckedCreateInput, 'ownerId'>
  ) {
    return tx.idBusinessV2RechargeBrowserSetting.upsert({
      where: { ownerId },
      create: { ownerId, ...data },
      update: data
    });
  }
}
