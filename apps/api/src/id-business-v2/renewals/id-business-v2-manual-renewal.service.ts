import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2ActivationStatusService } from '../activations/public-api';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2OrderEntryService, IdBusinessV2OrdersService } from '../orders/public-api';
import { V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE, toV2DecimalString } from '../decimal-policy';
import type { CreateIdBusinessV2ManualRenewalDto } from './dto/create-id-business-v2-manual-renewal.dto';
import {
  buildManualRenewalReplayResult,
  isUniqueConstraintError,
  MANUAL_RENEWAL_REPLAY_INCLUDE,
  normalizeManualRenewalInput,
  normalizeUuid,
  toManualRenewalLedgerResponse
} from './id-business-v2-manual-renewal-support';

interface LockedAccount {
  id: string;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  purchaseCost: PrismaNamespace.Decimal;
  soldByOrderId: string | null;
  lossReportedAt: Date | null;
}

const MAX_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');
const ROUNDING_MODE = V2_DECIMAL_ROUNDING_MODE;
@Injectable()
export class IdBusinessV2ManualRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activationStatusService: IdBusinessV2ActivationStatusService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly orderEntryService: IdBusinessV2OrderEntryService,
    private readonly ordersService: IdBusinessV2OrdersService
  ) {}

  async listOptions() {
    const [settlementPlatforms, services] = await Promise.all([
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'settlement_platform',
          status: 'active',
          deletedAt: null
        },
        select: {
          id: true,
          code: true,
          name: true,
          fixedFee: true,
          percentageFee: true
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
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
              deletedAt: null
            }
          }
        },
        select: {
          id: true,
          code: true,
          name: true,
          businessAmount: true,
          parent: {
            select: {
              id: true,
              name: true
            }
          },
          countryOption: {
            select: {
              id: true,
              code: true,
              name: true,
              currencyCode: true
            }
          }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);

    return {
      settlementPlatforms: settlementPlatforms.map((platform) => ({
        ...platform,
        fixedFee: toV2DecimalString(platform.fixedFee),
        percentageFee: toV2DecimalString(platform.percentageFee)
      })),
      services: services.map((service) => ({
        id: service.id,
        code: service.code,
        name: service.name,
        category: service.parent
          ? {
              id: service.parent.id,
              name: service.parent.name
            }
          : null,
        country: service.countryOption,
        businessAmount:
          service.businessAmount === null ? '0' : toV2DecimalString(service.businessAmount),
        currencyCode: service.countryOption?.currencyCode ?? null
      }))
    };
  }

  async create(
    activationIdValue: string,
    dto: CreateIdBusinessV2ManualRenewalDto,
    operator?: AuthenticatedUser
  ) {
    const activationId = normalizeUuid(activationIdValue, '续费记录');
    const input = normalizeManualRenewalInput(activationId, dto);
    let result: {
      orderId: string;
      activation: {
        id: string;
        orderId: string;
        customerId: string;
        accountId: string;
        serviceOptionId: string;
        openedAt: Date;
        dueAt: Date | null;
        status: string;
        createdAt: Date;
      };
      ledgerEntry: {
        id: string;
        accountId: string;
        balanceAmount: PrismaNamespace.Decimal;
        costAmount: PrismaNamespace.Decimal;
        balanceBefore: PrismaNamespace.Decimal;
        balanceAfter: PrismaNamespace.Decimal;
        costBefore: PrismaNamespace.Decimal;
        costAfter: PrismaNamespace.Decimal;
        averageCostBefore: PrismaNamespace.Decimal;
        averageCostAfter: PrismaNamespace.Decimal;
        createdAt: Date;
      };
      profitAmount: PrismaNamespace.Decimal;
      idempotentReplay: boolean;
    };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const replay = await tx.idBusinessV2Order.findUnique({
          where: {
            idempotencyKey: input.idempotencyKey
          },
          include: MANUAL_RENEWAL_REPLAY_INCLUDE
        });
        if (replay) {
          return buildManualRenewalReplayResult(replay, input);
        }

        await this.lockActivation(tx, activationId);
        const evaluatedAt = new Date();
        const sourceActivation = await tx.idBusinessV2Activation.findFirst({
          where: {
            id: activationId,
            AND: [this.activationStatusService.buildRenewalWorkbenchWhere(evaluatedAt)]
          },
          include: {
            order: true,
            account: {
              include: {
                countryOption: {
                  select: {
                    id: true,
                    code: true,
                    name: true
                  }
                },
                statusOption: {
                  select: {
                    code: true,
                    status: true,
                    deletedAt: true
                  }
                }
              }
            }
          }
        });
        if (!sourceActivation) {
          throw new NotFoundException('续费记录不存在或已不在可处理范围');
        }
        if (sourceActivation.order.status !== 'completed' || sourceActivation.order.deletedAt) {
          throw new ConflictException('原订单不是有效的已完成订单，不能续费');
        }
        if (!sourceActivation.dueAt) {
          throw new ConflictException('原开通记录缺少到期时间，不能续费');
        }
        if (input.openedAt.getTime() < sourceActivation.dueAt.getTime()) {
          throw new BadRequestException('续费开始时间不能早于原到期时间');
        }
        if (
          sourceActivation.account.recordStatus !== 'active' ||
          sourceActivation.account.deletedAt ||
          sourceActivation.account.lossReportedAt ||
          sourceActivation.account.soldByOrderId ||
          sourceActivation.account.statusOption.code !== 'normal' ||
          sourceActivation.account.statusOption.status !== 'active' ||
          sourceActivation.account.statusOption.deletedAt
        ) {
          throw new ConflictException('只有启用且状态正常的 ID 才能续费');
        }

        const selectedService = await tx.idBusinessV2Option.findFirst({
          where: {
            id: input.serviceOptionId,
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
                deletedAt: null
              }
            }
          },
          select: {
            id: true,
            countryOption: {
              select: {
                id: true,
                code: true,
                name: true
              }
            }
          }
        });
        if (!selectedService) {
          throw new BadRequestException('续费业务不存在或已停用');
        }
        if (
          !selectedService.countryOption ||
          selectedService.countryOption.id !== sourceActivation.account.countryOption.id
        ) {
          throw new ConflictException('续费业务所属国家与当前 ID 国家不一致');
        }

        const account = await this.lockAccount(tx, sourceActivation.accountId);
        const [activeOrderLock, duplicateRenewalOrder] = await Promise.all([
          tx.idBusinessV2AccountLock.findFirst({
            where: {
              accountId: sourceActivation.accountId,
              status: 'active',
              expiresAt: {
                gt: evaluatedAt
              },
              order: {
                is: {
                  status: {
                    in: ['draft', 'pending', 'waiting_external', 'processing']
                  },
                  deletedAt: null
                }
              }
            },
            select: {
              id: true
            }
          }),
          tx.idBusinessV2Order.findFirst({
            where: {
              id: {
                not: sourceActivation.orderId
              },
              accountId: sourceActivation.accountId,
              serviceOptionId: input.serviceOptionId,
              openedAt: input.openedAt,
              dueAt: input.dueAt,
              status: 'completed',
              deletedAt: null,
              activation: {
                is: {
                  accountId: sourceActivation.accountId,
                  serviceOptionId: input.serviceOptionId,
                  openedAt: input.openedAt,
                  dueAt: input.dueAt
                }
              }
            },
            select: {
              id: true,
              orderNo: true
            }
          })
        ]);
        if (activeOrderLock) {
          throw new ConflictException('该 ID 已被其他订单占用，请处理完成后再续费');
        }
        if (duplicateRenewalOrder) {
          throw new ConflictException(
            `相同续费周期的订单 ${duplicateRenewalOrder.orderNo} 已完成，请勿重复扣款`
          );
        }

        const movement = this.balanceCalculator.calculateConsumption(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          input.balanceAmount
        );
        const createdOrder = await this.orderEntryService.createManualRenewalOrderInTransaction(
          tx,
          {
            customerId: sourceActivation.customerId,
            serviceOptionId: input.serviceOptionId,
            accountId: sourceActivation.accountId,
            settlementPlatformOptionId: input.settlementPlatformOptionId,
            platformOrderNo: input.platformOrderNo,
            websiteAccountEncrypted: sourceActivation.order.websiteAccountEncrypted,
            websiteAccountHash: sourceActivation.order.websiteAccountHash,
            websiteAccountMasked: sourceActivation.order.websiteAccountMasked,
            receivedAmount: input.receivedAmount,
            balanceAmount: input.balanceAmount,
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            idempotencyKey: input.idempotencyKey,
            remark: input.remark
          },
          operator
        );
        const refundCostAmount = new PrismaNamespace.Decimal(0);
        const profitAmount = input.receivedAmount
          .minus(createdOrder.platformFeeAmount)
          .minus(movement.costAmount)
          .minus(refundCostAmount)
          .toDecimalPlaces(V2_DECIMAL_PLACES, ROUNDING_MODE);
        if (profitAmount.abs().greaterThan(MAX_AMOUNT)) {
          throw new BadRequestException('续费订单利润数值超出数据库范围');
        }

        const ledgerEntry = await tx.idBusinessV2BalanceLedger.create({
          data: {
            accountId: account.id,
            giftCardId: null,
            orderId: createdOrder.order.id,
            entryType: 'order_consumption',
            direction: 'debit',
            balanceAmount: movement.balanceAmount,
            costAmount: movement.costAmount,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            costBefore: movement.costBefore,
            costAfter: movement.costAfter,
            averageCostBefore: movement.averageCostBefore,
            averageCostAfter: movement.averageCostAfter,
            reversalOfEntryId: null,
            idempotencyKey: `manual_renewal:${createdOrder.order.id}:consumption`,
            remark: `手工续费余额扣减：${createdOrder.order.orderNo}`,
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
        const completedAt = new Date();
        await tx.idBusinessV2Order.update({
          where: {
            id: createdOrder.order.id
          },
          data: {
            accountCostAmount: account.purchaseCost,
            balanceCostAmount: movement.costAmount,
            refundCostAmount,
            profitAmount,
            status: 'completed',
            statusChangedAt: completedAt,
            updatedByUserId: operator?.id
          }
        });
        const activation = await tx.idBusinessV2Activation.create({
          data: {
            orderId: createdOrder.order.id,
            renewedFromActivationId: sourceActivation.id,
            customerId: sourceActivation.customerId,
            accountId: account.id,
            serviceOptionId: input.serviceOptionId,
            openedAt: input.openedAt,
            dueAt: input.dueAt,
            status: 'active',
            statusChangedAt: completedAt,
            autoRenewalStatus: 'unknown',
            autoRenewalChangedAt: null,
            remark: input.remark,
            createdByUserId: operator?.id,
            updatedByUserId: operator?.id
          }
        });

        await tx.auditLog.create({
          data: {
            userId: operator?.id,
            module: 'id_business_v2',
            action: 'id_business_v2.renewal.manual.complete',
            objectType: 'id_business_v2_order',
            objectId: createdOrder.order.id,
            beforeData: {
              sourceActivationId: sourceActivation.id,
              sourceOrderId: sourceActivation.orderId,
              accountId: account.id,
              appleIdMasked: sourceActivation.account.appleIdMasked,
              balance: movement.balanceBefore.toString(),
              balanceCostAmount: movement.costBefore.toString()
            },
            afterData: {
              executionMode: 'manual_operator_confirmation',
              orderId: createdOrder.order.id,
              orderNo: createdOrder.order.orderNo,
              activationId: activation.id,
              customerId: sourceActivation.customerId,
              serviceOptionId: input.serviceOptionId,
              websiteAccountMasked: sourceActivation.order.websiteAccountMasked,
              consumedBalance: movement.balanceAmount.toString(),
              consumedCost: movement.costAmount.toString(),
              balance: movement.balanceAfter.toString(),
              balanceCostAmount: movement.costAfter.toString(),
              platformFeeAmount: createdOrder.platformFeeAmount.toString(),
              profitAmount: profitAmount.toString(),
              openedAt: input.openedAt,
              dueAt: input.dueAt,
              externalSubscriptionActionPerformed: false
            },
            remark: `手工续费完成，已扣减余额并生成续费记录：${createdOrder.order.orderNo}`
          }
        });

        return {
          orderId: createdOrder.order.id,
          activation,
          ledgerEntry,
          profitAmount,
          idempotentReplay: false
        };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const replay = await this.prisma.idBusinessV2Order.findUnique({
        where: {
          idempotencyKey: input.idempotencyKey
        },
        include: MANUAL_RENEWAL_REPLAY_INCLUDE
      });
      if (!replay) {
        throw new ConflictException('平台订单号已存在或续费刚被其他请求处理，请刷新后核对');
      }
      result = buildManualRenewalReplayResult(replay, input);
    }

    return {
      order: await this.ordersService.get(result.orderId),
      activation: result.activation,
      ledgerEntry: toManualRenewalLedgerResponse(result.ledgerEntry),
      balance: {
        before: toV2DecimalString(result.ledgerEntry.balanceBefore),
        consumed: toV2DecimalString(result.ledgerEntry.balanceAmount),
        after: toV2DecimalString(result.ledgerEntry.balanceAfter),
        costBefore: toV2DecimalString(result.ledgerEntry.costBefore),
        consumedCost: toV2DecimalString(result.ledgerEntry.costAmount),
        costAfter: toV2DecimalString(result.ledgerEntry.costAfter),
        averageCostBefore: toV2DecimalString(result.ledgerEntry.averageCostBefore),
        averageCostAfter: toV2DecimalString(result.ledgerEntry.averageCostAfter)
      },
      profitAmount: toV2DecimalString(result.profitAmount),
      idempotentReplay: result.idempotentReplay,
      executionBoundary: {
        manualAccountingCompleted: true,
        systemBalanceConsumed: true,
        activationCreated: true,
        externalSubscriptionActionPerformed: false,
        nextStep: 'completed' as const
      }
    };
  }

  private async lockActivation(tx: Prisma.TransactionClient, activationId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
      SELECT "id"
      FROM "id_business_v2_activations"
      WHERE "id" = CAST(${activationId} AS UUID)
      FOR UPDATE
    `);
    if (!rows[0]) {
      throw new NotFoundException('续费记录不存在或已不在可处理范围');
    }
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<LockedAccount[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "purchase_cost" AS "purchaseCost",
        "sold_by_order_id" AS "soldByOrderId",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "record_status" = 'active'
        AND "deleted_at" IS NULL
        AND "loss_reported_at" IS NULL
      FOR UPDATE
    `);
    if (!rows[0]) {
      throw new ConflictException('ID 不存在、已停用或已删除');
    }
    if (rows[0].soldByOrderId) {
      throw new ConflictException('该 ID 已卖出，不能续费');
    }
    if (rows[0].lossReportedAt) {
      throw new ConflictException('已报损 ID 永久冻结，不能续费');
    }
    return rows[0];
  }
}
