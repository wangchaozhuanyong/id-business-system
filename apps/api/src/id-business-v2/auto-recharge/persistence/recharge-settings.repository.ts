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

  listPaymentCaps() {
    return this.prisma.idBusinessV2RechargePaymentCap.findMany({
      orderBy: [{ plan: 'asc' }, { currencyCode: 'asc' }]
    });
  }

  paymentCap(tx: V2CommandTransaction, plan: string, currencyCode: string) {
    return tx.idBusinessV2RechargePaymentCap.findUnique({
      where: { plan_currencyCode: { plan, currencyCode } }
    });
  }

  currencyForCap(tx: V2CommandTransaction, code: string) {
    return tx.idBusinessV2BankRechargeCurrency.findUnique({ where: { code } });
  }

  upsertPaymentCap(
    tx: V2CommandTransaction,
    plan: string,
    currencyCode: string,
    maxAmount: string,
    operatorId: string
  ) {
    return tx.idBusinessV2RechargePaymentCap.upsert({
      where: { plan_currencyCode: { plan, currencyCode } },
      create: { plan, currencyCode, maxAmount, updatedByUserId: operatorId },
      update: { maxAmount, updatedByUserId: operatorId }
    });
  }
}
