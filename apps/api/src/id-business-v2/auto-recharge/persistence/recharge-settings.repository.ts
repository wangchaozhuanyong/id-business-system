import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class RechargeSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(ownerId: string) {
    return this.prisma.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
  }

  findInTransaction(tx: V2CommandTransaction, ownerId: string) {
    return tx.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
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
