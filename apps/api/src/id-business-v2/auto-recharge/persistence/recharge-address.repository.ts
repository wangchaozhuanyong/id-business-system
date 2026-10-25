import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  assertEmployeeBusinessWriter,
  getEmployeeBusinessOwnerIds
} from '../../../v2-auth/system-super-admin';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { V2RechargeAddressListQuery, V2RechargeAddressStatus } from '@apple-business/shared';
import { Optional } from '@nestjs/common';
import { RechargeBillingRepository } from './recharge-billing.repository';
import { RECHARGE_ADDRESS_LOCATION } from '../recharge-address-validation';
import { randomUUID } from 'node:crypto';
import { generateRechargeBillingAddress } from '../recharge-billing-generator';

@Injectable()
export class RechargeAddressRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly billing?: RechargeBillingRepository
  ) {}

  private async ownerScope(
    client: Pick<Prisma.TransactionClient, 'securitySetting'>,
    ownerId: string
  ) {
    const owners = await getEmployeeBusinessOwnerIds(client, ownerId);
    return owners.length === 1 ? ownerId : { in: owners };
  }

  async requireUnused(tx: V2CommandTransaction, ownerId: string, id: string) {
    const address = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { id, ownerId: await this.ownerScope(tx, ownerId), status: 'unused' }
    });
    if (!address) throw new ConflictException('所选地址已使用、已停用或不存在，请重新选择');
    return address;
  }

  async requireAvailable(tx: V2CommandTransaction, ownerId: string, id: string) {
    const address = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { id, ownerId: await this.ownerScope(tx, ownerId), status: { in: ['unused', 'used'] } }
    });
    if (!address) throw new ConflictException('所选账单地址已停用或不存在');
    return address;
  }

  async createOrReuseManual(
    tx: V2CommandTransaction,
    ownerId: string,
    details: {
      country: string;
      line1: string;
      line2: string;
      city: string;
      state: string;
      postal_code: string;
    }
  ) {
    const existing = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { ownerId, line1: details.line1 }
    });
    if (existing) {
      if (
        existing.status === 'disabled' ||
        existing.country !== details.country ||
        (existing.line2 ?? '') !== details.line2 ||
        existing.city !== details.city ||
        existing.state !== details.state ||
        existing.postalCode !== details.postal_code
      ) {
        throw new ConflictException('相同街道已保存不同账单资料，请核对地址库');
      }
      return { address: existing, created: false };
    }
    const address = await tx.idBusinessV2RechargeAddress.create({
      data: {
        ownerId,
        line1: details.line1,
        line2: details.line2 || null,
        country: details.country,
        city: details.city,
        state: details.state,
        postalCode: details.postal_code,
        status: 'unused'
      }
    });
    return { address, created: true };
  }

  async markUsed(tx: V2CommandTransaction, ownerId: string, id: string, jobId?: string) {
    if (jobId) {
      const prior = await tx.idBusinessV2RechargeAddressUse.findUnique({ where: { jobId } });
      if (prior) {
        if ((prior.addressId ?? prior.addressReference) !== id || prior.ownerId !== ownerId)
          throw new ConflictException('同一充值任务不能更换账单地址');
        const priorAddress = { id, status: 'used' };
        return { before: priorAddress, after: priorAddress, changed: false };
      }
    }
    const address = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { id, ownerId: await this.ownerScope(tx, ownerId) }
    });
    if (!address) throw new NotFoundException('找不到本次充值使用的地址');
    if (address.status === 'disabled') throw new ConflictException('账单地址已停用');
    await this.billing?.rememberUsedAddress(tx, address, ownerId);
    if (jobId) {
      const prior = await tx.idBusinessV2RechargeAddressUse.findUnique({ where: { jobId } });
      if (prior) {
        if (prior.addressId !== id || prior.ownerId !== ownerId)
          throw new ConflictException('同一充值任务不能更换账单地址');
        return { before: address, after: address, changed: false };
      }
      await tx.idBusinessV2RechargeAddressUse.create({
        data: { jobId, addressId: id, addressReference: id, ownerId }
      });
    } else if (address.status === 'used') {
      return { before: address, after: address, changed: false };
    }
    const after = await tx.idBusinessV2RechargeAddress.update({
      where: { id },
      data: { status: 'used', usedAt: new Date() }
    });
    return { before: address, after, changed: true };
  }

  async list(ownerId: string, query: Required<V2RechargeAddressListQuery>) {
    const ownerScope = await this.ownerScope(this.prisma, ownerId);
    const where: Prisma.IdBusinessV2RechargeAddressWhereInput = {
      ownerId: ownerScope,
      ...(query.status === 'all' ? {} : { status: query.status }),
      ...(query.status === 'unused' ? { billingAllocations: { none: {} } } : {}),
      ...(query.keyword ? { line1: { contains: query.keyword } } : {})
    };
    const [items, total, unused, used, disabled] = await this.prisma.$transaction([
      this.prisma.idBusinessV2RechargeAddress.findMany({
        where,
        orderBy:
          query.status === 'unused'
            ? [{ createdAt: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.idBusinessV2RechargeAddress.count({ where }),
      this.prisma.idBusinessV2RechargeAddress.count({
        where: { ownerId: ownerScope, status: 'unused' }
      }),
      this.prisma.idBusinessV2RechargeAddress.count({
        where: { ownerId: ownerScope, status: 'used' }
      }),
      this.prisma.idBusinessV2RechargeAddress.count({
        where: { ownerId: ownerScope, status: 'disabled' }
      })
    ]);
    return { items, total, totals: { unused, used, disabled } };
  }

  async createMany(tx: V2CommandTransaction, ownerId: string, streets: string[]) {
    await assertEmployeeBusinessWriter(tx, ownerId);
    if (this.billing) {
      await this.billing.lock(tx);
      const unique: string[] = [];
      for (const line1 of streets) {
        if (
          !(await this.billing.isHistoricalAddress(tx, {
            line1,
            line2: null,
            ...RECHARGE_ADDRESS_LOCATION
          }))
        )
          unique.push(line1);
      }
      streets = unique;
    }
    const now = new Date();
    return tx.idBusinessV2RechargeAddress.createMany({
      data: streets.map((line1) => ({
        ownerId,
        line1,
        ...RECHARGE_ADDRESS_LOCATION,
        status: 'unused',
        updatedAt: now
      })),
      skipDuplicates: true
    });
  }

  async generate(tx: V2CommandTransaction, ownerId: string, count: number) {
    await assertEmployeeBusinessWriter(tx, ownerId);
    const items: Awaited<ReturnType<typeof tx.idBusinessV2RechargeAddress.findMany>> = [];
    // 唯一街道冲突只补缺额，不复用或启用旧记录；失败由外层事务整体撤销。
    for (let attempt = 0; attempt < 3 && items.length < count; attempt++) {
      const data = Array.from({ length: count - items.length }, () => ({
        ...generateRechargeBillingAddress(),
        id: randomUUID(),
        ownerId,
        status: 'unused'
      }));
      if (this.billing) {
        await this.billing.lock(tx);
        for (let index = data.length - 1; index >= 0; index--)
          if (await this.billing.isHistoricalAddress(tx, data[index]!)) data.splice(index, 1);
      }
      await tx.idBusinessV2RechargeAddress.createMany({ data, skipDuplicates: true });
      items.push(
        ...(await tx.idBusinessV2RechargeAddress.findMany({
          where: { ownerId, id: { in: data.map((item) => item.id) } }
        }))
      );
    }
    if (items.length !== count) throw new ConflictException('本次生成的街道重复，请重新生成');
    return items;
  }

  async updateStatus(
    tx: V2CommandTransaction,
    ownerId: string,
    id: string,
    status: V2RechargeAddressStatus
  ) {
    await assertEmployeeBusinessWriter(tx, ownerId);
    const address = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { id, ownerId: await this.ownerScope(tx, ownerId) }
    });
    if (!address) throw new NotFoundException('找不到该地址');
    if (address.status === 'used' && status !== 'used') {
      throw new ConflictException('已使用地址不能恢复为可用状态');
    }
    if (status === 'used') await this.billing?.rememberUsedAddress(tx, address, ownerId);
    if (address.status === status) return { before: address, after: address };
    const after = await tx.idBusinessV2RechargeAddress.update({
      where: { id },
      data: { status, usedAt: status === 'used' ? new Date() : null }
    });
    return { before: address, after };
  }
}
