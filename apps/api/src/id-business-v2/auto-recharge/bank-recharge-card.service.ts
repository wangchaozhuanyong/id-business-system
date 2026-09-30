import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getPagination } from '../../common/pagination';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeCardRepository } from './persistence/bank-recharge-card.repository';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import {
  bankRechargeCurrency,
  bankRechargeId,
  bankRechargeObject,
  bankRechargeText
} from './bank-recharge-validation';
import {
  cardExpiry,
  cardNumber,
  parseManagedCard,
  type ManagedCardInput
} from './bank-recharge-card-validation';

@Injectable()
export class BankRechargeCardService {
  constructor(
    private readonly repository: BankRechargeCardRepository,
    private readonly accounts: BankRechargeAccountService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async list(query: { page?: string; pageSize?: string; keyword?: string; status?: string } = {}) {
    const pagination = getPagination(query);
    const keyword = bankRechargeText(query.keyword, '搜索内容', 160, false);
    const status = bankRechargeText(query.status, '银行卡状态', 16, false);
    if (status && status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('银行卡状态无效');
    }
    const where = {
      ...(status ? { active: status === 'active' } : {}),
      ...(keyword
        ? {
            OR: [
              { label: { contains: keyword } },
              { last4: { contains: keyword } },
              { remark1: { contains: keyword } },
              { remark2: { contains: keyword } }
            ]
          }
        : {})
    };
    const [cards, total] = await Promise.all([
      this.repository.list(where, pagination.skip, pagination.take),
      this.repository.count(where)
    ]);
    const usage = await this.repository.distinctChargedAccounts(cards.map((card) => card.id));
    const counts = new Map<string, number>();
    for (const row of usage)
      if (row.cardId) counts.set(row.cardId, (counts.get(row.cardId) ?? 0) + 1);
    return {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      items: cards.map((card) => ({
        id: card.id,
        label: card.label,
        last4: card.last4,
        expiry: card.expiry,
        currencyCode: card.currencyCode,
        status: card.active ? 'active' : 'disabled',
        hasNumber: Boolean(card.numberEncrypted),
        remark1: card.remark1,
        remark2: card.remark2,
        accountCount: counts.get(card.id) ?? 0,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt
      }))
    };
  }

  async detail(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, '银行卡编号');
    return this.transactions.execute(
      async (tx) => {
        const card = await this.repository.findInTransaction(tx, id);
        if (!card) throw new NotFoundException('银行卡不存在');
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.card.number_read',
          objectType: 'bank_recharge_card',
          objectId: id,
          afterData: { last4: card.last4 },
          remark: '查看银行卡完整卡号'
        });
        return {
          id: card.id,
          label: card.label,
          number: this.encryption.decrypt(card.numberEncrypted),
          last4: card.last4,
          expiry: card.expiry,
          billingName: this.encryption.decrypt(card.billingNameEncrypted),
          billingAddressId: card.billingAddressId,
          currencyCode: card.currencyCode,
          status: card.active ? 'active' : 'disabled',
          remark1: card.remark1,
          remark2: card.remark2
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async orders(id: string, query: { page?: string; pageSize?: string } = {}) {
    bankRechargeId(id, '银行卡编号');
    if (!(await this.repository.find(id))) throw new NotFoundException('银行卡不存在');
    const pagination = getPagination(query);
    const [items, total] = await Promise.all([
      this.repository.listOrders(id, pagination.skip, pagination.take),
      this.repository.countOrders(id)
    ]);
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async checkAvailability(value: unknown) {
    const input = bankRechargeObject(value);
    if (Object.keys(input).some((key) => key !== 'number')) {
      throw new BadRequestException('银行卡检查资料格式无效');
    }
    const number = cardNumber(input.number);
    const card = await this.repository.findByNumberHash(this.encryption.hash(number)!);
    if (card && !card.active) throw new ConflictException('该银行卡已停用，不能用于充值');
    return { available: true };
  }

  encryptBillingName(value: string) {
    return this.encryption.encrypt(bankRechargeText(value, '持卡人姓名', 120));
  }

  async assertRechargeCard(
    tx: V2CommandTransaction,
    id: string,
    number: string,
    currencyCode: string,
    billingName: string,
    addressId: string
  ) {
    bankRechargeId(id, '银行卡编号');
    const card = await this.repository.findInTransaction(tx, id);
    if (
      !card ||
      !card.active ||
      card.currencyCode !== currencyCode ||
      card.numberHash !== this.encryption.hash(cardNumber(number))
    ) {
      throw new ConflictException('所选银行卡与本次卡号或币种不匹配');
    }
    if (
      card.billingNameEncrypted &&
      this.encryption.decrypt(card.billingNameEncrypted) !== billingName
    ) {
      throw new ConflictException('持卡人姓名与该卡已核实的账单资料不一致');
    }
    if (card.billingAddressId && card.billingAddressId !== addressId) {
      throw new ConflictException('账单地址与该卡已核实的地址不一致');
    }
    return card;
  }

  async bindVerifiedBilling(
    tx: V2CommandTransaction,
    cardId: string,
    nameEncrypted: string,
    addressId: string,
    operatorId: string,
    rechargeJobId: string
  ) {
    const card = await this.repository.findInTransaction(tx, cardId);
    if (!card || !card.active) return false;
    if (
      (card.billingNameEncrypted &&
        this.encryption.decrypt(card.billingNameEncrypted) !==
          this.encryption.decrypt(nameEncrypted)) ||
      (card.billingAddressId && card.billingAddressId !== addressId)
    ) {
      await this.audit.append(tx, {
        userId: operatorId,
        module: 'id_business_v2',
        action: 'id_business_v2.bank_recharge.card.billing_conflict',
        objectType: 'bank_recharge_card',
        objectId: cardId,
        afterData: { rechargeJobId },
        remark: '银行卡账单资料在付款期间变化，保留原绑定并等待人工核对'
      });
      return false;
    }
    if (card.billingNameEncrypted && card.billingAddressId) return true;
    await this.repository.update(tx, cardId, {
      ...(!card.billingNameEncrypted ? { billingNameEncrypted: nameEncrypted } : {}),
      ...(!card.billingAddressId ? { billingAddressId: addressId } : {})
    });
    await this.audit.append(tx, {
      userId: operatorId,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.card.billing_bind',
      objectType: 'bank_recharge_card',
      objectId: cardId,
      afterData: { addressId, rechargeJobId },
      remark: '官网付款与订阅均核实后绑定银行卡账单资料'
    });
    return true;
  }

  private async insert(
    tx: V2CommandTransaction,
    card: ManagedCardInput,
    operator: AuthenticatedUser
  ) {
    await this.accounts.requireCurrency(tx, card.currencyCode);
    const item = await this.repository.create(tx, {
      label: card.label,
      last4: card.last4,
      currency: { connect: { code: card.currencyCode } },
      numberEncrypted: this.encryption.encrypt(card.number),
      numberHash: this.encryption.hash(card.number),
      expiry: card.expiry,
      remark1: card.remark1 || null,
      remark2: card.remark2 || null,
      createdByUserId: operator.id
    });
    await this.audit.append(tx, {
      userId: operator.id,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.card.create',
      objectType: 'bank_recharge_card',
      objectId: item.id,
      afterData: { label: item.label, last4: item.last4, currencyCode: item.currencyCode },
      remark: '新增银充银行卡'
    });
    return {
      id: item.id,
      label: item.label,
      last4: item.last4,
      currencyCode: item.currencyCode,
      active: item.active
    };
  }

  async create(value: unknown, operator: AuthenticatedUser) {
    const card = parseManagedCard(value);
    return this.transactions.execute((tx) => this.insert(tx, card, operator), {
      changedScopes: ['auto-recharge'],
      requestId: randomUUID(),
      operator,
      retryMode: 'none',
      uniqueConflictMessage: '该银行卡号已保存'
    });
  }

  async importCards(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    const currencyCode = bankRechargeCurrency(input.currencyCode);
    if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 100) {
      throw new BadRequestException('每次只能导入 1 至 100 张银行卡');
    }
    const cards = input.cards.map((row: unknown, index: number) => {
      try {
        return parseManagedCard(row, currencyCode);
      } catch {
        throw new BadRequestException(`第 ${index + 1} 行银行卡资料无效；安全码不能导入或保存`);
      }
    });
    if (new Set(cards.map((card) => card.number)).size !== cards.length) {
      throw new BadRequestException('导入内容包含重复银行卡号');
    }
    return this.transactions.execute(
      async (tx) => {
        for (const card of cards) await this.insert(tx, card, operator);
        return { imported: cards.length };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        timeoutMs: 60_000,
        uniqueConflictMessage: '部分银行卡号已保存，整批未导入'
      }
    );
  }

  async update(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '银行卡编号');
    const input = bankRechargeObject(value);
    if (
      !Object.keys(input).length ||
      Object.keys(input).some(
        (key) =>
          !['number', 'expiry', 'label', 'currencyCode', 'remark1', 'remark2', 'status'].includes(
            key
          )
      )
    )
      throw new BadRequestException('银行卡资料包含不支持的字段；安全码不能保存');
    const number =
      input.number === undefined || input.number === '' ? undefined : cardNumber(input.number);
    const expiry =
      input.expiry === undefined || input.expiry === '' ? undefined : cardExpiry(input.expiry);
    const label =
      input.label === undefined ? undefined : bankRechargeText(input.label, '银行卡名称', 80);
    const currencyCode =
      input.currencyCode === undefined ? undefined : bankRechargeCurrency(input.currencyCode);
    const remark1 =
      input.remark1 === undefined
        ? undefined
        : bankRechargeText(input.remark1, '备注1', 500, false);
    const remark2 =
      input.remark2 === undefined
        ? undefined
        : bankRechargeText(input.remark2, '备注2', 500, false);
    if (/^\d{3,4}$/.test(remark1 ?? '') || /^\d{3,4}$/.test(remark2 ?? '')) {
      throw new BadRequestException('不能把安全码填入备注；安全码仅在单笔充值时临时输入');
    }
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'disabled') {
      throw new BadRequestException('银行卡状态无效');
    }
    return this.transactions.execute(
      async (tx) => {
        const previous = await this.repository.findInTransaction(tx, id);
        if (!previous) throw new NotFoundException('银行卡不存在');
        const numberChanged =
          number !== undefined && this.encryption.hash(number) !== previous.numberHash;
        const currencyChanged =
          currencyCode !== undefined && currencyCode !== previous.currencyCode;
        if ((numberChanged || currencyChanged) && (await this.repository.hasOrders(tx, id))) {
          throw new ConflictException('银行卡已有订单，不能更换卡号或币种；请新增银行卡');
        }
        if (currencyChanged) await this.accounts.requireCurrency(tx, currencyCode!);
        const item = await this.repository.update(tx, id, {
          ...(numberChanged
            ? {
                numberEncrypted: this.encryption.encrypt(number),
                numberHash: this.encryption.hash(number),
                last4: number!.slice(-4)
              }
            : {}),
          ...(expiry ? { expiry } : {}),
          ...(label ? { label } : {}),
          ...(currencyCode ? { currency: { connect: { code: currencyCode } } } : {}),
          ...(remark1 !== undefined ? { remark1: remark1 || null } : {}),
          ...(remark2 !== undefined ? { remark2: remark2 || null } : {}),
          ...(input.status ? { active: input.status === 'active' } : {})
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.card.update',
          objectType: 'bank_recharge_card',
          objectId: id,
          beforeData: { last4: previous.last4, active: previous.active },
          afterData: {
            last4: item.last4,
            active: item.active,
            numberChanged,
            expiryChanged: Boolean(expiry)
          },
          remark: '修改银充银行卡'
        });
        return { id, last4: item.last4, status: item.active ? 'active' : 'disabled' };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该银行卡号已保存'
      }
    );
  }

  async delete(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, '银行卡编号');
    try {
      return await this.transactions.execute(
        async (tx) => {
          const card = await this.repository.findInTransaction(tx, id);
          if (!card) throw new NotFoundException('银行卡不存在');
          if (await this.repository.hasOrders(tx, id))
            throw new ConflictException('银行卡已有订单，请改为停用');
          await this.repository.delete(tx, id);
          await this.audit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2',
            action: 'id_business_v2.bank_recharge.card.delete',
            objectType: 'bank_recharge_card',
            objectId: id,
            beforeData: { label: card.label, last4: card.last4 },
            remark: '删除未关联订单的银行卡'
          });
          return { id };
        },
        { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2003') {
        throw new ConflictException('银行卡已有订单，请改为停用');
      }
      throw error;
    }
  }
}
