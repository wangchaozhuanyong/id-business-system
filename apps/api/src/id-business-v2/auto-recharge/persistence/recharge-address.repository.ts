import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { V2RechargeAddressListQuery, V2RechargeAddressStatus } from '@apple-business/shared';
import { RECHARGE_ADDRESS_LOCATION } from '../recharge-address-validation';

@Injectable()
export class RechargeAddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  async requireUnused(tx: V2CommandTransaction, ownerId: string, id: string) {
    const address = await tx.idBusinessV2RechargeAddress.findFirst({
      where: { id, ownerId, status: 'unused' }
    });
    if (!address) throw new ConflictException('所选地址已使用、已停用或不存在，请重新选择');
    return address;
  }

  async markUsed(tx: V2CommandTransaction, ownerId: string, id: string) {
    const address = await tx.idBusinessV2RechargeAddress.findFirst({ where: { id, ownerId } });
    if (!address) throw new NotFoundException('找不到本次充值使用的地址');
    if (address.status === 'used') return { before: address, after: address, changed: false };
    const after = await tx.idBusinessV2RechargeAddress.update({
      where: { id },
      data: { status: 'used', usedAt: new Date() }
    });
    return { before: address, after, changed: true };
  }

  async list(ownerId: string, query: Required<V2RechargeAddressListQuery>) {
    const where: Prisma.IdBusinessV2RechargeAddressWhereInput = {
      ownerId,
      ...(query.status === 'all' ? {} : { status: query.status }),
      ...(query.keyword ? { line1: { contains: query.keyword } } : {})
    };
    const [items, total, unused, used, disabled] = await this.prisma.$transaction([
      this.prisma.idBusinessV2RechargeAddress.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.idBusinessV2RechargeAddress.count({ where }),
      this.prisma.idBusinessV2RechargeAddress.count({ where: { ownerId, status: 'unused' } }),
      this.prisma.idBusinessV2RechargeAddress.count({ where: { ownerId, status: 'used' } }),
      this.prisma.idBusinessV2RechargeAddress.count({ where: { ownerId, status: 'disabled' } })
    ]);
    return { items, total, totals: { unused, used, disabled } };
  }

  createMany(tx: V2CommandTransaction, ownerId: string, streets: string[]) {
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

  async updateStatus(
    tx: V2CommandTransaction,
    ownerId: string,
    id: string,
    status: V2RechargeAddressStatus
  ) {
    const address = await tx.idBusinessV2RechargeAddress.findFirst({ where: { id, ownerId } });
    if (!address) throw new NotFoundException('找不到该地址');
    if (address.status === 'used' && status !== 'used') {
      throw new ConflictException('已使用地址不能恢复为可用状态');
    }
    if (address.status === status) return { before: address, after: address };
    const after = await tx.idBusinessV2RechargeAddress.update({
      where: { id },
      data: { status, usedAt: status === 'used' ? new Date() : null }
    });
    return { before: address, after };
  }
}
