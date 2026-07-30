import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal } from '../decimal-policy';
import {
  IdBusinessV2FinanceFxService,
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeOptionalFinanceUuid
} from '../finance/public-api';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import { applyNewOrderAccountDisposition } from './id-business-v2-order-account-disposition';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { getIdBusinessV2OrderEntryOptions } from './id-business-v2-order-entry-options';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import {
  assertOrderEntryReplayMatches,
  calculatePlatformFee,
  generateOrderNo,
  isUniqueConstraintError,
  maskWebsiteAccount,
  normalizeCreateOrderInput,
  toOrderEntryLockSummary,
  writeOrderEntryAuditLog,
  type OrderEntryLockSummary
} from './id-business-v2-order-entry-support';

export interface CreateWaitingExternalOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  websiteAccountEncrypted: string | null;
  websiteAccountHash: string | null;
  websiteAccountMasked: string | null;
  receivedAmount: PrismaNamespace.Decimal;
  balanceAmount: PrismaNamespace.Decimal;
  openedAt: Date;
  dueAt: Date;
  idempotencyKey: string;
  remark: string | null;
  sourceActivationId: string;
}

export interface CreateManualRenewalOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  websiteAccountEncrypted: string | null;
  websiteAccountHash: string | null;
  websiteAccountMasked: string | null;
  receivedAmount: PrismaNamespace.Decimal;
  balanceAmount: PrismaNamespace.Decimal;
  openedAt: Date;
  dueAt: Date;
  idempotencyKey: string;
  remark: string | null;
}

@Injectable()
export class IdBusinessV2OrderEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly financeFxService: IdBusinessV2FinanceFxService
  ) {}

  async getEntryOptions(customerKeywordValue?: string) {
    return getIdBusinessV2OrderEntryOptions(
      this.prisma,
      this.fieldEncryptionService,
      customerKeywordValue
    );
  }

  async create(dto: CreateIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    const receivedCurrency = normalizeFinanceCurrency(dto.receivedCurrency ?? 'CNY', '收款币种');
    if (dto.receivedOriginalAmount === undefined && dto.receivedAmount === undefined) {
      throw new BadRequestException('原币收款金额不能为空');
    }
    const receivedOriginalAmount =
      dto.receivedOriginalAmount === undefined
        ? normalizeFinanceMoney(dto.receivedAmount, '实收金额', true)
        : normalizeFinanceMoney(dto.receivedOriginalAmount, '原币收款金额', true);
    const inputBeforeRate = normalizeCreateOrderInput(
      {
        ...dto,
        receivedAmount: dto.receivedAmount ?? receivedOriginalAmount.toString()
      },
      (value) => this.fieldEncryptionService.hash(value)
    );
    const receivedAt = dto.receivedAt
      ? normalizeFinanceDate(dto.receivedAt, '收款时间')
      : inputBeforeRate.openedAt;
    const manualRate =
      dto.receivedFxRateToCny === undefined
        ? null
        : normalizeFinanceRate(dto.receivedFxRateToCny, receivedCurrency);
    const receiptRate = await this.financeFxService.resolve({
      currency: receivedCurrency,
      occurredAt: receivedAt,
      fxRateSnapshotId: dto.receivedFxSnapshotId,
      manualRate,
      manualReason: dto.receivedManualRateReason,
      operator
    });
    const derivedReceivedAmount = roundV2Decimal(receivedOriginalAmount.mul(receiptRate.rateToCny));
    if (
      dto.receivedAmount !== undefined &&
      !derivedReceivedAmount.equals(inputBeforeRate.receivedAmount)
    ) {
      throw new BadRequestException('人民币实收与原币金额、交易汇率计算结果不一致');
    }
    const input =
      dto.receivedAmount === undefined
        ? normalizeCreateOrderInput(
            {
              ...dto,
              receivedAmount: derivedReceivedAmount.toString()
            },
            (value) => this.fieldEncryptionService.hash(value)
          )
        : inputBeforeRate;
    const receivedFinanceAccountId = normalizeOptionalFinanceUuid(
      dto.receivedFinanceAccountId,
      '收款账户'
    );
    let transactionResult: {
      orderId: string;
      lock: OrderEntryLockSummary | null;
      idempotentReplay: boolean;
    };

    try {
      transactionResult = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.idBusinessV2Order.findUnique({
          where: {
            idempotencyKey: input.idempotencyKey
          },
          include: {
            locks: {
              orderBy: {
                lockedAt: 'desc'
              },
              take: 1
            }
          }
        });
        if (existing) {
          assertOrderEntryReplayMatches(existing, existing.locks[0] ?? null, input);
          if (
            existing.receivedCurrency !== receivedCurrency ||
            !existing.receivedOriginalAmount.equals(receivedOriginalAmount) ||
            !existing.receivedFxRateToCny.equals(receiptRate.rateToCny) ||
            existing.receivedFinanceAccountId !== receivedFinanceAccountId ||
            existing.receivedAt?.getTime() !== receivedAt.getTime()
          ) {
            throw new ConflictException('幂等键已用于其他收款证据');
          }
          return {
            orderId: existing.id,
            lock: toOrderEntryLockSummary(existing.locks[0] ?? null),
            idempotentReplay: true
          };
        }

        await this.assertActiveCustomer(tx, input.customerId);
        await this.assertActiveService(tx, input.serviceOptionId);
        const settlementPlatform = await this.resolveSettlementPlatform(
          tx,
          input.settlementPlatformOptionId
        );
        if (receivedFinanceAccountId) {
          const financeAccount = await tx.idBusinessV2FinanceAccount.findUnique({
            where: { id: receivedFinanceAccountId }
          });
          if (
            !financeAccount ||
            financeAccount.status !== 'active' ||
            financeAccount.currency !== receivedCurrency
          ) {
            throw new BadRequestException('收款账户不存在、已停用或币种不一致');
          }
        }
        const platformFeeAmount = calculatePlatformFee(input.receivedAmount, settlementPlatform);
        const order = await tx.idBusinessV2Order.create({
          data: {
            orderNo: generateOrderNo(),
            customerId: input.customerId,
            serviceOptionId: input.serviceOptionId,
            accountId: null,
            settlementPlatformOptionId: input.settlementPlatformOptionId,
            platformOrderNo: input.platformOrderNo,
            websiteAccountEncrypted: this.fieldEncryptionService.encrypt(input.websiteAccount),
            websiteAccountHash: input.websiteAccountHash,
            websiteAccountMasked: maskWebsiteAccount(input.websiteAccount),
            receivedAmount: input.receivedAmount,
            receivedOriginalAmount,
            receivedCurrency,
            receivedFxRateToCny: receiptRate.rateToCny,
            receivedFxSnapshotId: receiptRate.id,
            receivedFinanceAccountId,
            receivedAt,
            platformFeeAmount,
            accountCostAmount: 0,
            accountDisposition: input.accountDisposition,
            balanceAmount: input.balanceAmount,
            balanceCostAmount: 0,
            refundCostAmount: null,
            profitAmount: null,
            status: 'pending',
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            idempotencyKey: input.idempotencyKey,
            remark: input.remark,
            createdByUserId: operator?.id,
            updatedByUserId: operator?.id
          }
        });
        const reservation = await this.orderLockService.reserveAccountForOrderInTransaction(
          tx,
          {
            orderId: order.id,
            accountId: input.accountId,
            expiresAt: input.dueAt,
            lockScope: input.lockScope,
            reason: '订单录入'
          },
          operator
        );
        await applyNewOrderAccountDisposition(
          tx,
          order.id,
          input.accountId,
          input.accountDisposition,
          operator
        );
        const auditedOrder = await tx.idBusinessV2Order.findUniqueOrThrow({
          where: {
            id: order.id
          }
        });

        await writeOrderEntryAuditLog(
          tx,
          auditedOrder,
          input,
          platformFeeAmount,
          reservation.lock,
          operator
        );
        return {
          orderId: order.id,
          lock: reservation.lock,
          idempotentReplay: false
        };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.prisma.idBusinessV2Order.findUnique({
        where: {
          idempotencyKey: input.idempotencyKey
        },
        include: {
          locks: {
            orderBy: {
              lockedAt: 'desc'
            },
            take: 1
          }
        }
      });
      if (!existing) {
        throw new ConflictException('平台订单号已存在或订单刚被其他请求创建，请刷新后核对');
      }
      assertOrderEntryReplayMatches(existing, existing.locks[0] ?? null, input);
      transactionResult = {
        orderId: existing.id,
        lock: toOrderEntryLockSummary(existing.locks[0] ?? null),
        idempotentReplay: true
      };
    }

    return {
      order: await this.ordersService.get(transactionResult.orderId),
      lock: transactionResult.lock,
      idempotentReplay: transactionResult.idempotentReplay,
      nextStep: 'waiting_balance_consumption' as const
    };
  }

  async createWaitingExternalOrderInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateWaitingExternalOrderInput,
    operator?: AuthenticatedUser
  ) {
    await this.assertActiveCustomer(tx, input.customerId);
    await this.assertActiveService(tx, input.serviceOptionId);
    const settlementPlatform = await this.resolveSettlementPlatform(
      tx,
      input.settlementPlatformOptionId
    );
    const platformFeeAmount = calculatePlatformFee(input.receivedAmount, settlementPlatform);
    const order = await tx.idBusinessV2Order.create({
      data: {
        orderNo: generateOrderNo(),
        customerId: input.customerId,
        serviceOptionId: input.serviceOptionId,
        accountId: input.accountId,
        settlementPlatformOptionId: input.settlementPlatformOptionId,
        platformOrderNo: input.platformOrderNo,
        websiteAccountEncrypted: input.websiteAccountEncrypted,
        websiteAccountHash: input.websiteAccountHash,
        websiteAccountMasked: input.websiteAccountMasked,
        receivedAmount: input.receivedAmount,
        receivedOriginalAmount: input.receivedAmount,
        receivedCurrency: 'CNY',
        receivedFxRateToCny: 1,
        receivedAt: input.openedAt,
        platformFeeAmount,
        accountCostAmount: 0,
        accountDisposition: 'retained',
        balanceAmount: input.balanceAmount,
        balanceCostAmount: 0,
        refundCostAmount: null,
        profitAmount: null,
        status: 'waiting_external',
        openedAt: input.openedAt,
        dueAt: input.dueAt,
        idempotencyKey: input.idempotencyKey,
        remark: input.remark,
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      }
    });

    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.renewal.open_request.order_create',
        objectType: 'id_business_v2_order',
        objectId: order.id,
        afterData: {
          orderNo: order.orderNo,
          sourceActivationId: input.sourceActivationId,
          customerId: input.customerId,
          serviceOptionId: input.serviceOptionId,
          accountId: input.accountId,
          settlementPlatformOptionId: input.settlementPlatformOptionId,
          platformOrderNo: input.platformOrderNo,
          websiteAccountMasked: input.websiteAccountMasked,
          receivedAmount: input.receivedAmount.toString(),
          platformFeeAmount: platformFeeAmount.toString(),
          balanceAmount: input.balanceAmount.toString(),
          openedAt: input.openedAt,
          dueAt: input.dueAt,
          status: 'waiting_external',
          balanceConsumed: false,
          appleOfficialOpenExecuted: false,
          nextStep: 'waiting_apple_execution'
        },
        remark: `创建 V2 续费待执行订单：${order.orderNo}`
      }
    });

    return {
      order,
      platformFeeAmount
    };
  }

  async createManualRenewalOrderInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateManualRenewalOrderInput,
    operator?: AuthenticatedUser
  ) {
    await this.assertActiveCustomer(tx, input.customerId);
    await this.assertActiveService(tx, input.serviceOptionId);
    const settlementPlatform = await this.resolveSettlementPlatform(
      tx,
      input.settlementPlatformOptionId
    );
    const platformFeeAmount = calculatePlatformFee(input.receivedAmount, settlementPlatform);
    const statusChangedAt = new Date();
    const order = await tx.idBusinessV2Order.create({
      data: {
        orderNo: generateOrderNo(),
        customerId: input.customerId,
        serviceOptionId: input.serviceOptionId,
        accountId: input.accountId,
        settlementPlatformOptionId: input.settlementPlatformOptionId,
        platformOrderNo: input.platformOrderNo,
        websiteAccountEncrypted: input.websiteAccountEncrypted,
        websiteAccountHash: input.websiteAccountHash,
        websiteAccountMasked: input.websiteAccountMasked,
        receivedAmount: input.receivedAmount,
        receivedOriginalAmount: input.receivedAmount,
        receivedCurrency: 'CNY',
        receivedFxRateToCny: 1,
        receivedAt: input.openedAt,
        platformFeeAmount,
        accountCostAmount: 0,
        accountDisposition: 'retained',
        balanceAmount: input.balanceAmount,
        balanceCostAmount: 0,
        refundCostAmount: null,
        profitAmount: null,
        status: 'processing',
        statusChangedAt,
        openedAt: input.openedAt,
        dueAt: input.dueAt,
        idempotencyKey: input.idempotencyKey,
        remark: input.remark,
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      }
    });

    return {
      order,
      platformFeeAmount
    };
  }

  private async assertActiveCustomer(tx: Prisma.TransactionClient, customerId: string) {
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

  private async assertActiveService(tx: Prisma.TransactionClient, serviceOptionId: string) {
    const service = await tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: {
          gt: 0
        },
        parent: {
          is: {
            type: 'business_category',
            status: 'active',
            deletedAt: null
          }
        },
        countryOption: {
          is: {
            type: 'country',
            status: 'active',
            deletedAt: null,
            currencyCode: {
              not: null
            }
          }
        }
      },
      select: {
        id: true
      }
    });
    if (!service) {
      throw new BadRequestException('业务不存在、已停用或尚未配置国家、金额和货币');
    }
  }

  private async resolveSettlementPlatform(
    tx: Prisma.TransactionClient,
    settlementPlatformOptionId: string | null
  ) {
    if (!settlementPlatformOptionId) return null;
    const platform = await tx.idBusinessV2Option.findFirst({
      where: {
        id: settlementPlatformOptionId,
        type: 'settlement_platform',
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        fixedFee: true,
        percentageFee: true
      }
    });
    if (!platform) {
      throw new BadRequestException('结算平台不存在或已停用');
    }
    return platform;
  }
}
