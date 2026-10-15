import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class RechargeProxyRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(
    where: Prisma.IdBusinessV2RechargeProxyWhereInput,
    skip: number,
    take: number,
    sortOrder: 'asc' | 'desc' = 'desc'
  ) {
    return this.prisma.idBusinessV2RechargeProxy.findMany({
      where,
      select: {
        id: true,
        countryCode: true,
        kind: true,
        connectionMode: true,
        protocol: true,
        urlHash: true,
        active: true,
        remark1: true,
        remark2: true,
        remark: true,
        displayHost: true,
        exitIp: true,
        latencyMs: true,
        testMessage: true,
        testedAt: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: [{ updatedAt: sortOrder }, { id: sortOrder }],
      skip,
      take
    });
  }

  count(where: Prisma.IdBusinessV2RechargeProxyWhereInput) {
    return this.prisma.idBusinessV2RechargeProxy.count({ where });
  }

  activeCountries() {
    return this.prisma.idBusinessV2RechargeProxy.groupBy({
      by: ['countryCode'],
      where: { active: true, countryCode: { not: null }, kind: { not: null } },
      orderBy: { countryCode: 'asc' }
    });
  }

  find(id: string) {
    return this.prisma.idBusinessV2RechargeProxy.findUnique({ where: { id } });
  }

  findInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeProxy.findUnique({ where: { id } });
  }

  lock(tx: V2CommandTransaction, id: string) {
    return acquireMysqlTransactionLock(tx, `proxy-pool:${id}`);
  }

  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2RechargeProxyCreateInput) {
    return tx.idBusinessV2RechargeProxy.create({ data });
  }

  update(tx: V2CommandTransaction, id: string, data: Prisma.IdBusinessV2RechargeProxyUpdateInput) {
    return tx.idBusinessV2RechargeProxy.update({ where: { id }, data });
  }

  delete(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeProxy.delete({ where: { id } });
  }

  async hasJobs(tx: V2CommandTransaction, id: string) {
    return (
      (await tx.idBusinessV2RechargeJob.findFirst({
        where: { proxyId: id },
        select: { id: true }
      })) ??
      (await tx.idBusinessV2RegistrationJob.findFirst({
        where: { proxyId: id },
        select: { id: true }
      })) ??
      (await this.onlineReference(tx, id))
    );
  }

  async onlineReference(tx: V2CommandTransaction, id: string) {
    const aliases = await tx.idBusinessV2ProxyAlias.findMany({
      where: { proxyId: id },
      select: { oldId: true }
    });
    const ids = [id, ...aliases.map((row) => row.oldId)];
    return tx.onlineRechargeTask.findFirst({
      where: {
        AND: [
          {
            OR: ids.flatMap((proxyId) => [
              { payload: { path: '$.proxyId', equals: proxyId } },
              { payload: { path: '$.ids', array_contains: proxyId } }
            ])
          },
          { operation: { not: 'proxy_test' } }
        ]
      },
      select: { id: true }
    });
  }
  async hasActiveTest(tx: V2CommandTransaction, id: string) {
    const aliases = await tx.idBusinessV2ProxyAlias.findMany({
      where: { proxyId: id },
      select: { oldId: true }
    });
    return tx.onlineRechargeTask.findFirst({
      where: {
        operation: 'proxy_test',
        deletedAt: null,
        status: { in: ['queued', 'running'] },
        OR: [id, ...aliases.map((row) => row.oldId)].flatMap((proxyId) => [
          { payload: { path: '$.proxyId', equals: proxyId } },
          { payload: { path: '$.ids', array_contains: proxyId } }
        ])
      },
      select: { id: true }
    });
  }
  resolveOnlineId(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ProxyAlias.findUnique({ where: { oldId: id } });
  }
  active(tx: V2CommandTransaction, id?: string) {
    return tx.idBusinessV2RechargeProxy.findMany({
      where: { active: true, ...(id ? { id } : {}) },
      take: 500
    });
  }
  byHash(tx: V2CommandTransaction, urlHash: string) {
    return tx.idBusinessV2RechargeProxy.findUnique({ where: { urlHash } });
  }
}
