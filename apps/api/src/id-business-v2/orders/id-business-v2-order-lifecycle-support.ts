import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { IdBusinessV2AccountLockScope, Prisma as PrismaNamespace } from '@prisma/client';
import type { IdBusinessV2BalanceLedger, IdBusinessV2Order, Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import type { DeleteIdBusinessV2OrderDto } from './dto/delete-id-business-v2-order.dto';
import type { UpdateIdBusinessV2OrderDto } from './dto/update-id-business-v2-order.dto';
import type { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import type { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { maskWebsiteAccount } from './id-business-v2-order-entry-support';
import {
  V2_DECIMAL_PATTERN,
  V2_DECIMAL_PLACES,
  V2_DECIMAL_ROUNDING_MODE,
  toV2Decimal,
  toV2DecimalString
} from '../decimal-policy';
interface LockedAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  lossReportedAt: Date | null;
}

export interface LifecycleTransactionResult {
  orderId: string;
  reversalLedger: IdBusinessV2BalanceLedger | null;
  balanceRestored: boolean;
  lockReleased: boolean;
  idempotentReplay: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');
const ROUNDING_MODE = V2_DECIMAL_ROUNDING_MODE;
const DELETABLE_STATUSES = new Set(['refunded', 'cancelled', 'failed']);

export class IdBusinessV2OrderLifecycleSupport {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly ordersService: IdBusinessV2OrdersService
  ) {}

  async remove(
    orderIdValue: string,
    dto: DeleteIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = this.normalizeUuid(orderIdValue, '订单');
    const reason = this.normalizeReason(dto.reason);

    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, true);
      if (order.deletedAt) {
        return {
          deleted: true,
          idempotentReplay: true
        };
      }
      if (!DELETABLE_STATUSES.has(order.status)) {
        throw new ConflictException('只有已退款、已取消或失败订单可以删除');
      }

      const release = await this.orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `订单软删除：${reason}`,
        operator
      );
      const deletedAt = new Date();
      await tx.idBusinessV2Order.update({
        where: {
          id: order.id
        },
        data: {
          deletedAt,
          updatedByUserId: operator?.id
        }
      });
      await this.writeLifecycleAudit(
        tx,
        'delete',
        order,
        {
          deletedAt,
          reason,
          lockReleased: release.released,
          dataPreserved: true
        },
        operator
      );
      return {
        deleted: true,
        idempotentReplay: false
      };
    });
  }

  async runLifecycleTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    conflictMessage: string
  ) {
    try {
      return await this.prisma.$transaction(callback);
    } catch (error) {
      this.rethrowWriteConflict(error, conflictMessage);
    }
  }

  async buildLifecycleResponse(result: LifecycleTransactionResult) {
    return {
      order: await this.ordersService.get(result.orderId),
      reversalLedger: result.reversalLedger
        ? this.toReversalLedgerResponse(result.reversalLedger)
        : null,
      balanceRestored: result.balanceRestored,
      lockReleased: result.lockReleased,
      idempotentReplay: result.idempotentReplay
    };
  }

  async restoreConsumption(
    tx: Prisma.TransactionClient,
    order: IdBusinessV2Order,
    consumption: IdBusinessV2BalanceLedger,
    idempotencyKey: string,
    remark: string,
    operator?: AuthenticatedUser
  ) {
    if (!order.accountId || consumption.accountId !== order.accountId) {
      throw new ConflictException('订单消费流水与绑定 ID 不一致，不能恢复余额');
    }
    if (
      consumption.entryType !== 'order_consumption' ||
      consumption.direction !== 'debit' ||
      consumption.reversalOfEntryId !== null
    ) {
      throw new ConflictException('订单原消费流水证据无效，不能恢复余额');
    }

    const account = await this.lockAccount(tx, order.accountId);
    if (account.lossReportedAt) {
      throw new ConflictException('已报损 ID 永久冻结，不能恢复余额');
    }
    const movement = this.balanceCalculator.calculateReversalCredit(
      {
        currentBalance: account.currentBalance,
        balanceCostAmount: account.balanceCostAmount
      },
      consumption.balanceAmount,
      consumption.costAmount
    );
    const ledger = await tx.idBusinessV2BalanceLedger.create({
      data: {
        accountId: account.id,
        giftCardId: null,
        orderId: order.id,
        entryType: 'order_consumption_reversal',
        direction: 'credit',
        balanceAmount: movement.balanceAmount,
        costAmount: movement.costAmount,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        costBefore: movement.costBefore,
        costAfter: movement.costAfter,
        averageCostBefore: movement.averageCostBefore,
        averageCostAfter: movement.averageCostAfter,
        reversalOfEntryId: consumption.id,
        idempotencyKey,
        remark,
        createdByUserId: operator?.id
      }
    });
    await tx.idBusinessV2Account.update({
      where: {
        id: account.id
      },
      data: {
        currentBalance: movement.balanceAfter,
        balanceCostAmount: movement.costAfter,
        updatedByUserId: operator?.id
      }
    });
    return {
      account,
      ledger
    };
  }

  async lockOrder(tx: Prisma.TransactionClient, orderId: string, includeDeleted = false) {
    const rows = includeDeleted
      ? await tx.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
          SELECT "id"
          FROM "id_business_v2_orders"
          WHERE "id" = CAST(${orderId} AS UUID)
          FOR UPDATE
        `)
      : await tx.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
          SELECT "id"
          FROM "id_business_v2_orders"
          WHERE
            "id" = CAST(${orderId} AS UUID)
            AND "deleted_at" IS NULL
          FOR UPDATE
        `);
    if (!rows[0]) {
      throw new NotFoundException('订单不存在或已删除');
    }
    const order = await tx.idBusinessV2Order.findUnique({
      where: {
        id: orderId
      }
    });
    if (!order || (!includeDeleted && order.deletedAt)) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<LockedAccountRow[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "apple_id_masked" AS "appleIdMasked",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `);
    const account = rows[0];
    if (!account) {
      throw new NotFoundException('订单绑定的 ID 不存在或已删除');
    }
    return account;
  }

  findConsumption(tx: Prisma.TransactionClient, orderId: string) {
    return tx.idBusinessV2BalanceLedger.findUnique({
      where: {
        orderId_entryType: {
          orderId,
          entryType: 'order_consumption'
        }
      }
    });
  }

  findReversal(tx: Prisma.TransactionClient, orderId: string) {
    return tx.idBusinessV2BalanceLedger.findUnique({
      where: {
        orderId_entryType: {
          orderId,
          entryType: 'order_consumption_reversal'
        }
      }
    });
  }

  assertReversalReplay(reversal: IdBusinessV2BalanceLedger | null, idempotencyKey: string) {
    if (reversal && reversal.idempotencyKey !== idempotencyKey) {
      throw new ConflictException('订单已经使用其他请求撤销消费，请刷新后核对');
    }
  }

  async assertActiveCustomer(tx: Prisma.TransactionClient, customerId: string) {
    const customer = await tx.idBusinessV2Customer.findFirst({
      where: {
        id: customerId,
        recordStatus: 'active',
        deletedAt: null
      },
      select: {
        id: true
      }
    });
    if (!customer) {
      throw new BadRequestException('客户不存在、已停用或已删除');
    }
  }

  async assertActiveService(tx: Prisma.TransactionClient, serviceOptionId: string) {
    const service = await tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true
      }
    });
    if (!service) {
      throw new BadRequestException('业务不存在或已停用');
    }
  }

  async resolveSettlementPlatform(
    tx: Prisma.TransactionClient,
    platformId: string | null,
    allowDisabledExisting: boolean
  ) {
    if (!platformId) return null;
    const platform = await tx.idBusinessV2Option.findFirst({
      where: {
        id: platformId,
        type: 'settlement_platform',
        status: allowDisabledExisting ? undefined : 'active',
        deletedAt: null
      },
      select: {
        fixedFee: true,
        percentageFee: true
      }
    });
    if (!platform) {
      throw new BadRequestException('结算平台不存在、已停用或已删除');
    }
    return platform;
  }

  calculatePlatformFee(
    receivedAmount: PrismaNamespace.Decimal,
    platform: {
      fixedFee: PrismaNamespace.Decimal;
      percentageFee: PrismaNamespace.Decimal;
    } | null
  ) {
    if (!platform) return new PrismaNamespace.Decimal(0);
    const normalizedReceivedAmount = toV2Decimal(receivedAmount);
    const fee = toV2Decimal(platform.fixedFee)
      .plus(normalizedReceivedAmount.mul(toV2Decimal(platform.percentageFee)).div(100))
      .toDecimalPlaces(V2_DECIMAL_PLACES, ROUNDING_MODE);
    if (fee.greaterThan(MAX_AMOUNT)) {
      throw new BadRequestException('平台手续费数值过大');
    }
    return fee;
  }

  calculateProfit(
    receivedAmount: PrismaNamespace.Decimal,
    platformFeeAmount: PrismaNamespace.Decimal,
    accountCostAmount: PrismaNamespace.Decimal,
    balanceCostAmount: PrismaNamespace.Decimal,
    refundCostAmount: PrismaNamespace.Decimal | null
  ) {
    const profit = toV2Decimal(receivedAmount)
      .minus(toV2Decimal(platformFeeAmount))
      .minus(toV2Decimal(accountCostAmount))
      .minus(toV2Decimal(balanceCostAmount))
      .minus(toV2Decimal(refundCostAmount ?? 0))
      .toDecimalPlaces(V2_DECIMAL_PLACES, ROUNDING_MODE);
    if (profit.abs().greaterThan(MAX_AMOUNT)) {
      throw new BadRequestException('订单利润数值超出数据库范围');
    }
    return profit;
  }

  resolveWebsiteAccount(dto: UpdateIdBusinessV2OrderDto, order: IdBusinessV2Order) {
    if (dto.clearWebsiteAccount && dto.websiteAccount !== undefined) {
      const normalized = this.normalizeOptionalString(dto.websiteAccount, '客户网站账号', 255);
      if (normalized) {
        throw new BadRequestException('清空网站账号时不能同时填写新账号');
      }
    }
    if (dto.clearWebsiteAccount) {
      return {
        encrypted: null,
        hash: null,
        masked: null
      };
    }
    if (dto.websiteAccount === undefined) {
      return {
        encrypted: order.websiteAccountEncrypted,
        hash: order.websiteAccountHash,
        masked: order.websiteAccountMasked
      };
    }
    const value = this.normalizeOptionalString(dto.websiteAccount, '客户网站账号', 255);
    return {
      encrypted: this.fieldEncryptionService.encrypt(value),
      hash: this.fieldEncryptionService.hash(value),
      masked: maskWebsiteAccount(value)
    };
  }

  async writeLifecycleAudit(
    tx: Prisma.TransactionClient,
    action: 'cancel' | 'refund' | 'delete',
    order: IdBusinessV2Order,
    afterData: Prisma.InputJsonValue,
    operator?: AuthenticatedUser
  ) {
    const labels = {
      cancel: '取消',
      refund: '退款',
      delete: '软删除'
    };
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: `id_business_v2.order.${action}`,
        objectType: 'id_business_v2_order',
        objectId: order.id,
        beforeData: this.toOrderAuditSnapshot(order),
        afterData,
        remark: `${labels[action]} V2 订单：${order.orderNo}`
      }
    });
  }

  toOrderAuditSnapshot(order: IdBusinessV2Order): Prisma.InputJsonValue {
    return {
      orderNo: order.orderNo,
      customerId: order.customerId,
      serviceOptionId: order.serviceOptionId,
      accountId: order.accountId,
      settlementPlatformOptionId: order.settlementPlatformOptionId,
      platformOrderNo: order.platformOrderNo,
      websiteAccountMasked: order.websiteAccountMasked,
      receivedAmount: order.receivedAmount.toString(),
      platformFeeAmount: order.platformFeeAmount.toString(),
      accountDisposition: order.accountDisposition,
      accountCostAmount: order.accountCostAmount.toString(),
      balanceAmount: order.balanceAmount.toString(),
      balanceCostAmount: order.balanceCostAmount.toString(),
      refundCostAmount: order.refundCostAmount?.toString() ?? null,
      profitAmount: order.profitAmount?.toString() ?? null,
      openedAt: order.openedAt,
      dueAt: order.dueAt,
      remark: order.remark,
      status: order.status,
      statusChangedAt: order.statusChangedAt,
      deletedAt: order.deletedAt
    };
  }

  toReversalLedgerResponse(entry: IdBusinessV2BalanceLedger) {
    return {
      id: entry.id,
      accountId: entry.accountId,
      entryType: entry.entryType,
      direction: entry.direction,
      balanceAmount: toV2DecimalString(entry.balanceAmount),
      costAmount: toV2DecimalString(entry.costAmount),
      balanceBefore: toV2DecimalString(entry.balanceBefore),
      balanceAfter: toV2DecimalString(entry.balanceAfter),
      costBefore: toV2DecimalString(entry.costBefore),
      costAfter: toV2DecimalString(entry.costAfter),
      averageCostBefore: toV2DecimalString(entry.averageCostBefore),
      averageCostAfter: toV2DecimalString(entry.averageCostAfter),
      reversalOfEntryId: entry.reversalOfEntryId,
      createdAt: entry.createdAt
    };
  }

  assertUpdateHasChanges(dto: UpdateIdBusinessV2OrderDto) {
    const mutableKeys: Array<keyof UpdateIdBusinessV2OrderDto> = [
      'customerId',
      'serviceOptionId',
      'accountId',
      'settlementPlatformOptionId',
      'platformOrderNo',
      'websiteAccount',
      'clearWebsiteAccount',
      'receivedAmount',
      'receivedOriginalAmount',
      'receivedCurrency',
      'receivedFxRateToCny',
      'receivedFxSnapshotId',
      'receivedManualRateReason',
      'balanceAmount',
      'accountDisposition',
      'openedAt',
      'dueAt',
      'lockScope',
      'remark'
    ];
    if (!mutableKeys.some((key) => dto[key] !== undefined)) {
      throw new BadRequestException('至少填写一个需要修改的订单字段');
    }
  }

  hasCoreFieldChanges(dto: UpdateIdBusinessV2OrderDto) {
    return [
      dto.customerId,
      dto.serviceOptionId,
      dto.accountId,
      dto.balanceAmount,
      dto.accountDisposition,
      dto.lockScope
    ].some((value) => value !== undefined);
  }

  normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  normalizeOptionalUuid(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.normalizeUuid(value, label);
  }

  normalizeOptionalString(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException(`${label}格式无效`);
    }
    const normalized = String(value).trim();
    if (normalized.length > maxLength) {
      throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
    }
    return normalized || null;
  }

  normalizeAmount(value: unknown, label: string, allowZero: boolean) {
    const normalized =
      typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数`);
    }
    const amount = new PrismaNamespace.Decimal(normalized);
    if ((!allowZero && amount.lessThanOrEqualTo(0)) || (allowZero && amount.lessThan(0))) {
      throw new BadRequestException(`${label}${allowZero ? '不能为负数' : '必须大于 0'}`);
    }
    if (amount.greaterThan(MAX_AMOUNT)) {
      throw new BadRequestException(`${label}数值过大`);
    }
    return amount;
  }

  normalizeDate(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${label}不能为空`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return date;
  }

  normalizeLockScope(value: unknown): IdBusinessV2AccountLockScope {
    if (
      value === IdBusinessV2AccountLockScope.by_service ||
      value === IdBusinessV2AccountLockScope.global
    ) {
      return value;
    }
    throw new BadRequestException('锁定范围无效');
  }

  normalizeReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2 || normalized.length > 500) {
      throw new BadRequestException('操作原因必须为 2 至 500 个字符');
    }
    return normalized;
  }

  normalizeIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    }
    return normalized;
  }

  rethrowWriteConflict(error: unknown, message: string): never {
    if (
      error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    ) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
