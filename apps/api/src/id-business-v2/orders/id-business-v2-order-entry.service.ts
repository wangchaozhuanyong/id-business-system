import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import {
  assertOrderEntryReplayMatches,
  calculatePlatformFee,
  generateOrderNo,
  isUniqueConstraintError,
  maskWebsiteAccount,
  normalizeCreateOrderInput,
  normalizeOptionalString,
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

const MAX_CUSTOMERS = 50;

@Injectable()
export class IdBusinessV2OrderEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly orderLockService: IdBusinessV2OrderLockService
  ) {}

  async getEntryOptions(customerKeywordValue?: string) {
    const customerKeyword = normalizeOptionalString(customerKeywordValue, '客户搜索', 160);
    const phoneHash = customerKeyword
      ? this.fieldEncryptionService.hash(customerKeyword.replace(/\s+/g, ''))
      : null;

    const [customers, countries, categories, services, settlementPlatforms] =
      await this.prisma.$transaction([
        this.prisma.idBusinessV2Customer.findMany({
          where: {
            deletedAt: null,
            recordStatus: 'active',
            OR: customerKeyword
              ? [
                  {
                    name: {
                      contains: customerKeyword,
                      mode: 'insensitive'
                    }
                  },
                  {
                    wechat: {
                      contains: customerKeyword,
                      mode: 'insensitive'
                    }
                  },
                  {
                    phoneTail: {
                      contains: customerKeyword.slice(-8),
                      mode: 'insensitive'
                    }
                  },
                  {
                    phoneHash: phoneHash ?? undefined
                  }
                ]
              : undefined
          },
          select: {
            id: true,
            name: true,
            wechat: true,
            phoneMasked: true
          },
          take: MAX_CUSTOMERS,
          orderBy: [{ name: 'asc' }, { id: 'asc' }]
        }),
        this.prisma.idBusinessV2Option.findMany({
          where: {
            type: 'country',
            status: 'active',
            deletedAt: null
          },
          select: {
            id: true,
            code: true,
            name: true,
            currencyCode: true
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
        }),
        this.prisma.idBusinessV2Option.findMany({
          where: {
            type: 'business_category',
            status: 'active',
            deletedAt: null,
            parentId: null
          },
          select: {
            id: true,
            code: true,
            name: true
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
            parentId: true,
            countryOptionId: true,
            businessAmount: true,
            countryOption: {
              select: {
                currencyCode: true
              }
            }
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
        }),
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
        })
      ]);

    return {
      customers: customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        wechat: customer.wechat,
        maskedPhone: customer.phoneMasked
      })),
      countries: countries.map((country) => ({
        ...country,
        children: categories
          .map((category) => ({
            ...category,
            children: services
              .filter(
                (service) =>
                  service.countryOptionId === country.id && service.parentId === category.id
              )
              .map((service) => ({
                id: service.id,
                code: service.code,
                name: service.name,
                businessAmount: service.businessAmount?.toString() ?? '0',
                currencyCode: service.countryOption?.currencyCode ?? country.currencyCode
              }))
          }))
          .filter((category) => category.children.length > 0)
      })),
      settlementPlatforms: settlementPlatforms.map((platform) => ({
        id: platform.id,
        code: platform.code,
        name: platform.name,
        fixedFee: platform.fixedFee.toString(),
        percentageFee: platform.percentageFee.toString()
      }))
    };
  }

  async create(dto: CreateIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    const input = normalizeCreateOrderInput(dto, (value) =>
      this.fieldEncryptionService.hash(value)
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
            platformFeeAmount,
            accountCostAmount: 0,
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

        await writeOrderEntryAuditLog(
          tx,
          order,
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
        platformFeeAmount,
        accountCostAmount: 0,
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
        platformFeeAmount,
        accountCostAmount: 0,
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
