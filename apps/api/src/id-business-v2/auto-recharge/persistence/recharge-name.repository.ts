import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { Prisma } from '@prisma/client';

@Injectable()
export class RechargeNameRepository {
  constructor(private readonly prisma: PrismaService) {}
  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-recharge-card-names');
  }
  list(where: Prisma.IdBusinessV2RechargeNameWhereInput, skip: number, take: number) {
    return this.prisma.idBusinessV2RechargeName.findMany({
      where,
      skip,
      take,
      orderBy: { sequence: 'asc' }
    });
  }
  count(where: Prisma.IdBusinessV2RechargeNameWhereInput) {
    return this.prisma.idBusinessV2RechargeName.count({ where });
  }
  find(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeName.findUnique({ where: { id } });
  }
  byHash(tx: V2CommandTransaction, nameHash: string) {
    return tx.idBusinessV2RechargeName.findUnique({ where: { nameHash } });
  }
  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2RechargeNameCreateInput) {
    return tx.idBusinessV2RechargeName.create({ data });
  }
  update(tx: V2CommandTransaction, id: string, data: Prisma.IdBusinessV2RechargeNameUpdateInput) {
    return tx.idBusinessV2RechargeName.update({ where: { id }, data });
  }
  next(tx: V2CommandTransaction) {
    return tx.idBusinessV2RechargeName.findFirst({
      where: { active: true },
      orderBy: [{ matchCount: 'asc' }, { sequence: 'asc' }]
    });
  }
  binding(tx: V2CommandTransaction, numberHash: string) {
    return tx.idBusinessV2RechargeCardName.findUnique({ where: { numberHash } });
  }
  bind(
    tx: V2CommandTransaction,
    numberHash: string,
    nameEncrypted: string,
    confirmed: boolean,
    nameId?: string
  ) {
    return tx.idBusinessV2RechargeCardName.upsert({
      where: { numberHash },
      create: { numberHash, nameEncrypted, confirmed, nameId },
      update: { nameEncrypted, confirmed, ...(nameId ? { nameId } : {}) }
    });
  }
  cardById(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeCard.findUnique({ where: { id } });
  }
  card(tx: V2CommandTransaction, numberHash: string) {
    return tx.idBusinessV2BankRechargeCard.findUnique({ where: { numberHash } });
  }
  createCard(tx: V2CommandTransaction, data: Prisma.IdBusinessV2BankRechargeCardCreateInput) {
    return tx.idBusinessV2BankRechargeCard.create({ data });
  }
}
