import { ConflictException, Injectable } from '@nestjs/common';
import type { IdBusinessV2RechargeAddress } from '@prisma/client';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import type { V2CommandTransaction } from '../../runtime/public-api';
import {
  generateRechargeBillingAddress as generateExistingBillingAddress,
  generateRechargeBillingName as generateExistingBillingName
} from '../recharge-billing-generator';
import { getEmployeeBusinessOwnerIds } from '../../../v2-auth/system-super-admin';
import { object } from '../recharge-validation';

type BillingAddress = Pick<
  IdBusinessV2RechargeAddress,
  'country' | 'line1' | 'line2' | 'city' | 'state' | 'postalCode'
>;
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const stateNames: Record<string, string> = {
  or: 'oregon',
  de: 'delaware',
  mt: 'montana',
  nh: 'new hampshire',
  ak: 'alaska'
};
export function billingAddressKey(address: BillingAddress) {
  return JSON.stringify(
    [
      address.country,
      address.line1,
      address.line2 ?? '',
      address.city,
      stateNames[normalized(address.state)] ?? address.state,
      address.postalCode
    ].map(normalized)
  );
}
export function billingJobSettled(job: { state: string; result: unknown }) {
  const report = object(job.result);
  if (
    !['finished', 'cancelled'].includes(job.state) ||
    report.payment_status === 'unknown' ||
    report.status === 'payment_result_unknown'
  )
    return false;
  const neverPaid =
    report.payment_attempted === false &&
    report.payment_requests_sent === 0 &&
    Number(report.confirmation_requests_sent ?? 0) === 0 &&
    !report.payment_evidence &&
    report.payment_status !== 'paid' &&
    !['paid_pending_activation', 'subscription_activated'].includes(String(report.status));
  return (
    (report.status === 'subscription_activated' && report.payment_status === 'paid') ||
    report.payment_status === 'declined' ||
    report.operator_resolution === 'confirmed_no_bank_request' ||
    neverPaid
  );
}

@Injectable()
export class RechargeBillingRepository {
  constructor(private readonly encryption: FieldEncryptionService) {}
  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-recharge-billing-identities');
  }
  hashAddress(address: BillingAddress) {
    return this.encryption.hash(billingAddressKey(address))!;
  }
  private async seedHistory(tx: V2CommandTransaction) {
    // 首次分配前纳入现有历史；用永久指纹保护之后的重新导入和重新生成。
    if (
      await tx.idBusinessV2RechargeBillingAllocation.findUnique({
        where: { requestKey: 'history-v1' }
      })
    )
      return;
    const [addresses, names, bindings, cards] = await Promise.all([
      tx.idBusinessV2RechargeAddress.findMany({ where: { status: 'used' } }),
      tx.idBusinessV2RechargeName.findMany({ where: { matchCount: { gt: 0 } } }),
      tx.idBusinessV2RechargeCardName.findMany(),
      tx.idBusinessV2BankRechargeCard.findMany({ where: { billingNameEncrypted: { not: null } } })
    ]);
    const fingerprints = [
      ...addresses.map((address) => ({
        ownerId: address.ownerId,
        addressHash: this.hashAddress(address)
      })),
      ...names.map((name) => ({ ownerId: 'history', nameHash: name.nameHash })),
      ...[
        ...bindings.map((item) => item.nameEncrypted),
        ...cards.map((item) => item.billingNameEncrypted)
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => ({
          ownerId: 'history',
          nameHash: this.encryption.hash(normalized(this.encryption.decrypt(value)!))!
        }))
    ];
    if (fingerprints.length)
      await tx.idBusinessV2RechargeBillingAllocation.createMany({
        data: fingerprints,
        skipDuplicates: true
      });
    await tx.idBusinessV2RechargeBillingAllocation.create({
      data: { ownerId: 'history', requestKey: 'history-v1' }
    });
  }
  async rememberUsedAddress(tx: V2CommandTransaction, address: BillingAddress, ownerId: string) {
    await acquireMysqlTransactionLock(tx, 'auto-recharge-card-names');
    await this.lock(tx);
    await tx.idBusinessV2RechargeBillingAllocation.createMany({
      data: [{ ownerId, addressHash: this.hashAddress(address) }],
      skipDuplicates: true
    });
  }
  async isHistoricalAddress(tx: V2CommandTransaction, address: BillingAddress) {
    return Boolean(
      await tx.idBusinessV2RechargeBillingAllocation.findUnique({
        where: { addressHash: this.hashAddress(address) }
      })
    );
  }
  private async replenish(tx: V2CommandTransaction, ownerId: string, ownerIds: string[]) {
    let removed = 0;
    const used = await tx.idBusinessV2RechargeAddress.findMany({
      where: {
        ownerId: { in: ownerIds },
        OR: [{ status: 'used' }, { billingAllocations: { some: { jobId: { not: null } } } }]
      }
    });
    for (const address of used) {
      const allocations = await tx.idBusinessV2RechargeBillingAllocation.findMany({
        where: { addressId: address.id, jobId: { not: null } },
        select: { jobId: true }
      });
      const jobs = await tx.idBusinessV2RechargeJob.findMany({
        where: {
          OR: [
            { result: { path: '$.addressId', equals: address.id } },
            {
              id: {
                in: [
                  ...allocations.map((allocation) => allocation.jobId!),
                  ...(
                    await tx.idBusinessV2RechargeAddressUse.findMany({
                      where: { addressId: address.id },
                      select: { jobId: true }
                    })
                  ).map((use) => use.jobId)
                ]
              }
            }
          ]
        },
        select: { state: true, result: true }
      });
      if (!jobs.every(billingJobSettled)) continue;
      const openDraft = await tx.idBusinessV2RechargeBillingAllocation.count({
        where: { addressId: address.id, jobId: null, requestKey: { not: null } }
      });
      if (openDraft) continue;
      await tx.idBusinessV2RechargeBillingAllocation.createMany({
        data: [{ ownerId, addressHash: this.hashAddress(address) }],
        skipDuplicates: true
      });
      // 外键只清除地址指针，原任务、使用记录和排重指纹继续保留。
      await tx.idBusinessV2RechargeAddressUse.updateMany({
        where: { addressId: address.id, addressReference: null },
        data: { addressReference: address.id }
      });
      await tx.idBusinessV2RechargeAddress.delete({ where: { id: address.id } });
      await tx.idBusinessV2RechargeBillingAllocation.updateMany({
        where: { addressHash: this.hashAddress(address), jobId: { not: null } },
        data: { nameEncrypted: null }
      });
      removed++;
    }
    const existing = new Set(
      (
        await tx.idBusinessV2RechargeAddress.findMany({
          select: {
            country: true,
            line1: true,
            line2: true,
            city: true,
            state: true,
            postalCode: true
          }
        })
      ).map((address) => this.hashAddress(address))
    );
    let generated = 0;
    for (let attempt = 0; attempt < 10000 && generated < 100; attempt++) {
      const result = generateExistingBillingAddress();
      const address = {
        country: result.country,
        line1: result.line1,
        line2: null,
        city: result.city,
        state: result.state,
        postalCode: result.postalCode
      };
      const fingerprint = this.hashAddress(address);
      if (existing.has(fingerprint) || (await this.isHistoricalAddress(tx, address))) continue;
      // 旧唯一键是 ownerId + 街道，保持兼容，不通过修改生成算法规避冲突。
      if (
        await tx.idBusinessV2RechargeAddress.findFirst({ where: { ownerId, line1: address.line1 } })
      )
        continue;
      await tx.idBusinessV2RechargeAddress.create({
        data: { ...address, ownerId, status: 'unused' }
      });
      existing.add(fingerprint);
      generated++;
    }
    if (generated !== 100)
      throw new ConflictException('现有地址生成器无法补足100条不重复地址，请检查地址库后重试');
    return { generated, removed };
  }
  async allocate(
    tx: V2CommandTransaction,
    input: { key: string; numberHash: string; ownerId: string; addressId?: string }
  ) {
    await this.lock(tx);
    await this.seedHistory(tx);
    const requestKey = this.encryption.hash(
      JSON.stringify([input.ownerId, input.key, input.numberHash])
    )!;
    const previous = await tx.idBusinessV2RechargeBillingAllocation.findUnique({
      where: { requestKey },
      include: { address: true }
    });
    if (previous) {
      if (!previous.nameEncrypted || !previous.address || previous.jobId)
        throw new ConflictException('这份账单资料已使用，请开始新一笔充值');
      return { allocation: previous, generated: 0, removed: 0 };
    }
    const owners = await getEmployeeBusinessOwnerIds(tx, input.ownerId);
    let candidates = await tx.idBusinessV2RechargeAddress.findMany({
      where: {
        ownerId: { in: owners },
        status: 'unused',
        billingAllocations: { none: {} },
        ...(input.addressId ? { id: input.addressId } : {})
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    let address: IdBusinessV2RechargeAddress | undefined;
    for (const candidate of candidates) {
      if (!(await this.isHistoricalAddress(tx, candidate))) {
        address = candidate;
        break;
      }
    }
    let generated = 0,
      removed = 0;
    if (!address) {
      if (input.addressId) throw new ConflictException('所选地址已分配或已使用，请重新选择地址');
      const next = await this.replenish(tx, input.ownerId, owners);
      generated = next.generated;
      removed = next.removed;
      candidates = await tx.idBusinessV2RechargeAddress.findMany({
        where: { ownerId: { in: owners }, status: 'unused', billingAllocations: { none: {} } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      });
      address = candidates[0];
    }
    if (!address) throw new ConflictException('没有可分配的账单地址');
    const usedNames = new Set(
      (
        await tx.idBusinessV2RechargeBillingAllocation.findMany({
          where: { nameHash: { not: null } },
          select: { nameHash: true }
        })
      ).map((item) => item.nameHash)
    );
    let name = '';
    for (let attempt = 0; attempt < 10000; attempt++) {
      const candidate = generateExistingBillingName();
      const hash = this.encryption.hash(normalized(candidate))!;
      if (usedNames.has(hash)) continue;
      name = candidate;
      break;
    }
    if (!name)
      throw new ConflictException(
        '现有姓名库和生成词表已用尽，请补充未使用的姓名；系统不会循环复用'
      );
    const allocation = await tx.idBusinessV2RechargeBillingAllocation.create({
      data: {
        requestKey,
        ownerId: input.ownerId,
        cardHash: input.numberHash,
        nameHash: this.encryption.hash(normalized(name)),
        nameEncrypted: this.encryption.encrypt(name),
        addressHash: this.hashAddress(address),
        addressId: address.id
      },
      include: { address: true }
    });
    return { allocation, generated, removed };
  }
  async verify(
    tx: V2CommandTransaction,
    id: string,
    input: {
      numberHash: string;
      name: string;
      ownerId?: string;
      addressId?: string;
      jobId?: string;
    }
  ) {
    await this.lock(tx);
    const allocation = await tx.idBusinessV2RechargeBillingAllocation.findUnique({ where: { id } });
    if (
      !allocation ||
      allocation.cardHash !== input.numberHash ||
      !allocation.nameEncrypted ||
      allocation.nameHash !== this.encryption.hash(normalized(input.name)) ||
      (input.ownerId && allocation.ownerId !== input.ownerId) ||
      (input.addressId && allocation.addressId !== input.addressId) ||
      (allocation.jobId && allocation.jobId !== input.jobId)
    )
      throw new ConflictException('本次账单姓名或地址已变化、已使用，请重新分配');
    if (input.jobId)
      return tx.idBusinessV2RechargeBillingAllocation.update({
        where: { id },
        data: { jobId: input.jobId }
      });
    return allocation;
  }
}
