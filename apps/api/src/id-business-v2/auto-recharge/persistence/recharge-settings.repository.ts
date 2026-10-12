import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, IdBusinessV2RechargeBrowserSetting } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
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

  lock(tx: V2CommandTransaction) {
    return acquireMysqlTransactionLock(tx, 'auto-recharge-single-worker');
  }

  async pinLegacyConnections(
    tx: V2CommandTransaction,
    ownerId: string,
    metadata: Record<string, unknown>
  ) {
    const jobs = await tx.idBusinessV2RechargeJob.findMany({
      where: {
        ownerId,
        action: 'bitbrowser',
        state: { not: 'finished' },
        leaseUntil: { gt: new Date() }
      },
      take: 30
    });
    for (const job of jobs) {
      const result = job.result as Record<string, unknown>;
      if (result.connection_snapshot_encrypted || result.transport === 'web_direct') continue;
      await tx.idBusinessV2RechargeJob.update({
        where: { id: job.id },
        data: {
          result: { ...result, ...metadata } as Prisma.InputJsonValue
        }
      });
    }
  }

  listProfiles(ownerId: string) {
    return this.prisma.idBusinessV2RechargeConnectionProfile.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true }
    });
  }

  async effective(
    ownerId: string,
    profileId?: string | null,
    tx?: V2CommandTransaction
  ): Promise<
    | (IdBusinessV2RechargeBrowserSetting & {
        connectionProfileId?: string;
        connectionProfileName?: string;
      })
    | null
  > {
    const client = tx ?? this.prisma;
    const base = await client.idBusinessV2RechargeBrowserSetting.findUnique({ where: { ownerId } });
    const metadata = base?.browserOptions as Record<string, unknown> | undefined;
    const selected = profileId === undefined ? metadata?.selectedConnectionProfileId : profileId;
    if (typeof selected !== 'string') return base;
    const profile = await client.idBusinessV2RechargeConnectionProfile.findFirst({
      where: { id: selected, ownerId }
    });
    if (!profile) throw new NotFoundException('找不到本人的连接配置，请重新选择');
    return {
      ...(profile.configuration as unknown as IdBusinessV2RechargeBrowserSetting),
      ownerId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      connectionProfileId: profile.id,
      connectionProfileName: profile.name
    };
  }

  async saveProfile(
    tx: V2CommandTransaction,
    input: {
      id: string;
      ownerId: string;
      name: string;
      configuration: Prisma.InputJsonValue;
      expectedUpdatedAt?: string | null;
      create: boolean;
    }
  ) {
    const data = { name: input.name, configuration: input.configuration };
    if (input.create)
      return tx.idBusinessV2RechargeConnectionProfile.create({
        data: { id: input.id, ownerId: input.ownerId, ...data }
      });
    if (!input.expectedUpdatedAt) throw new ConflictException('请重新读取连接配置后保存');
    const changed = await tx.idBusinessV2RechargeConnectionProfile.updateMany({
      where: { id: input.id, ownerId: input.ownerId, updatedAt: new Date(input.expectedUpdatedAt) },
      data: {
        ...data,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(input.expectedUpdatedAt) + 1))
      }
    });
    if (changed.count !== 1) throw new ConflictException('连接配置已被修改，请重新读取后核对');
    return tx.idBusinessV2RechargeConnectionProfile.findFirstOrThrow({
      where: { id: input.id, ownerId: input.ownerId }
    });
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
