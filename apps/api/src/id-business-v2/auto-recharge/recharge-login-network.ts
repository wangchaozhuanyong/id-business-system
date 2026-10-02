import { ConflictException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { IdBusinessV2RechargeLoginNetwork } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { type V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import { bankRechargeEmail } from './bank-recharge-validation';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';

export type VerifiedLoginNetworkInput = {
  email: string;
  accountKey: string;
  ip: string;
  countryCode: string;
  expectedCountryCode: string;
  jobId: string;
  ownerId: string;
};

export function loginNetworkSummary(
  network: IdBusinessV2RechargeLoginNetwork | undefined,
  encryption: FieldEncryptionService
) {
  return {
    firstLoginNetwork: network
      ? {
          ip: encryption.decrypt(network.firstIpEncrypted),
          countryCode: network.firstCountryCode,
          observedAt: network.firstLoginAt
        }
      : null,
    lastLoginNetwork: network
      ? {
          ip: encryption.decrypt(network.lastIpEncrypted),
          countryCode: network.lastCountryCode,
          observedAt: network.lastLoginAt
        }
      : null
  };
}

export async function loginNetworkGuard(
  tx: V2CommandTransaction,
  email: string,
  countryCode: string,
  repository: BankRechargeRepository,
  encryption: FieldEncryptionService
) {
  const emailHash = encryption.hash(bankRechargeEmail(email))!;
  const network = await repository.loginNetwork(tx, emailHash);
  if (network && network.firstCountryCode !== countryCode)
    throw new ConflictException('代理国家与该账号首次登录国家不一致，已限制登录');
  return network ? encryption.decrypt(network.lastIpEncrypted) : null;
}

export async function recordVerifiedLoginNetwork(
  tx: V2CommandTransaction,
  input: VerifiedLoginNetworkInput,
  repository: BankRechargeRepository,
  encryption: FieldEncryptionService,
  audit: V2TransactionalAuditService
) {
  if (
    !isIP(input.ip) ||
    !/^[A-Z]{2}$/.test(input.countryCode) ||
    input.countryCode !== input.expectedCountryCode ||
    !/^[a-f0-9]{64}$/.test(input.accountKey)
  )
    throw new ConflictException('代理出口 IP 或国家未核实，已限制登录');
  const emailHash = encryption.hash(bankRechargeEmail(input.email))!;
  const previous = await repository.loginNetwork(tx, emailHash);
  if (
    previous &&
    (previous.firstCountryCode !== input.countryCode ||
      (previous.officialAccountKey && previous.officialAccountKey !== input.accountKey))
  )
    throw new ConflictException('代理国家或官网账号与首次登录记录不一致，已限制登录');
  if (previous?.lastJobId === input.jobId) return;
  const observedAt = new Date();
  if (previous) {
    await repository.updateLoginNetwork(tx, {
      where: { emailHash },
      data: {
        officialAccountKey: input.accountKey,
        lastIpEncrypted: encryption.encrypt(input.ip)!,
        lastCountryCode: input.countryCode,
        lastLoginAt: observedAt,
        lastJobId: input.jobId,
        loginCount: { increment: 1 }
      }
    });
  } else {
    await repository.createLoginNetwork(tx, {
      data: {
        emailHash,
        officialAccountKey: input.accountKey,
        firstIpEncrypted: encryption.encrypt(input.ip)!,
        firstCountryCode: input.countryCode,
        firstLoginAt: observedAt,
        lastIpEncrypted: encryption.encrypt(input.ip)!,
        lastCountryCode: input.countryCode,
        lastLoginAt: observedAt,
        lastJobId: input.jobId
      }
    });
  }
  await audit.append(tx, {
    userId: input.ownerId,
    module: 'id_business_v2',
    action: previous
      ? 'id_business_v2.auto_recharge.login_network.update'
      : 'id_business_v2.auto_recharge.login_network.create',
    objectType: 'recharge_login_network',
    // 审计对象编号仅容纳任务 UUID；完整邮箱哈希保留在登录出口表。
    objectId: input.jobId,
    afterData: { countryCode: input.countryCode, jobId: input.jobId },
    remark: previous ? '记录本次已核验的代理出口' : '锁定账号首次登录代理国家和出口'
  });
}
