import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { ACCOUNT_COPY_SETTINGS_OWNER_ID, accountCopySuffix } from '../account-copy-settings';

@Injectable()
export class RechargeSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(ownerId: string) {
    return this.prisma.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
  }

  findInTransaction(tx: V2CommandTransaction, ownerId: string) {
    return tx.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
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
