import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  assertV2ExpectedUpdatedAt,
  normalizeV2ExpectedUpdatedAt,
  type V2CommandTransaction
} from '../runtime/public-api';
import { RechargeNameRepository } from './persistence/recharge-name.repository';
import { cardNumber, cardExpiry } from './bank-recharge-card-validation';
import {
  bankRechargeCurrency,
  bankRechargeId,
  bankRechargeObject,
  bankRechargeText
} from './bank-recharge-validation';

@Injectable()
export class RechargeNameService {
  constructor(
    private readonly repository: RechargeNameRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}
  private name(value: unknown) {
    return bankRechargeText(value, '姓名', 120).replace(/\s+/g, ' ');
  }
  private hash(value: string) {
    return this.encryption.hash(value.toLocaleLowerCase('en-US'))!;
  }
  lock(tx: V2CommandTransaction) {
    return this.repository.lock(tx);
  }
  async list(query: { page?: string; pageSize?: string; keyword?: string; status?: string } = {}) {
    const pagination = getPagination(query);
    const keyword = bankRechargeText(query.keyword, '姓名搜索', 120, false);
    if (query.status && !['active', 'disabled'].includes(query.status))
      throw new BadRequestException('姓名状态无效');
    const where = {
      ...(keyword ? { nameHash: this.hash(this.name(keyword)) } : {}),
      ...(query.status ? { active: query.status === 'active' } : {})
    };
    const [items, total] = await Promise.all([
      this.repository.list(where, pagination.skip, pagination.take),
      this.repository.count(where)
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        sequence: item.sequence,
        name: this.encryption.decrypt(item.nameEncrypted),
        active: item.active,
        matchCount: item.matchCount,
        lastMatchedAt: item.lastMatchedAt,
        updatedAt: item.updatedAt
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }
  async import(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some((key) => key !== 'names') ||
      !Array.isArray(input.names) ||
      input.names.length < 1 ||
      input.names.length > 2000
    )
      throw new BadRequestException('每次请录入 1 至 2000 个姓名');
    const inputNames = input.names;
    const names = [
      ...new Map(
        inputNames.map((value) => {
          const name = this.name(value);
          return [this.hash(name), name] as const;
        })
      ).entries()
    ];
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        let imported = 0;
        for (const [nameHash, name] of names) {
          if (await this.repository.byHash(tx, nameHash)) continue;
          await this.repository.create(tx, {
            nameHash,
            nameEncrypted: this.encryption.encrypt(name)!
          });
          imported++;
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.names.import',
          objectType: 'recharge_name',
          afterData: { imported, skipped: inputNames.length - imported },
          remark: '录入姓名库'
        });
        return { imported, skipped: inputNames.length - imported };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
  async update(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '姓名编号');
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some((key) => !['name', 'active', 'expectedUpdatedAt'].includes(key)) ||
      (input.active !== undefined && typeof input.active !== 'boolean')
    )
      throw new BadRequestException('姓名资料格式无效');
    const expected = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '姓名');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const previous = await this.repository.find(tx, id);
        if (!previous) throw new NotFoundException('姓名不存在');
        assertV2ExpectedUpdatedAt(previous.updatedAt, expected, '姓名');
        const name = input.name === undefined ? null : this.name(input.name);
        const duplicate = name ? await this.repository.byHash(tx, this.hash(name)) : null;
        if (duplicate && duplicate.id !== id) throw new ConflictException('此姓名已录入');
        const result = await this.repository.update(tx, id, {
          ...(name
            ? { nameEncrypted: this.encryption.encrypt(name)!, nameHash: this.hash(name) }
            : {}),
          ...(input.active !== undefined ? { active: input.active as boolean } : {})
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.names.update',
          objectType: 'recharge_name',
          objectId: id,
          afterData: { active: result.active, nameChanged: Boolean(name) },
          remark: '修改姓名库，历史银行卡绑定保持原姓名'
        });
        return { id };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
  async match(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    if (Object.keys(input).some((key) => key !== 'number'))
      throw new BadRequestException('银行卡匹配资料格式无效');
    const number = cardNumber(input.number);
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const numberHash = this.encryption.hash(number)!;
        const card = await this.repository.card(tx, numberHash);
        if (card && !card.active) throw new ConflictException('该银行卡已停用，不能用于充值');
        const binding = await this.repository.binding(tx, numberHash);
        let nameEncrypted = binding?.confirmed
          ? binding.nameEncrypted
          : card?.billingNameEncrypted || binding?.nameEncrypted;
        let confirmed = Boolean(card?.billingNameEncrypted || binding?.confirmed);
        let nameId = binding?.nameId ?? null;
        if (!nameEncrypted) {
          const next = await this.repository.next(tx);
          if (!next) throw new ConflictException('姓名库暂无启用姓名，请先录入姓名');
          nameEncrypted = next.nameEncrypted;
          nameId = next.id;
          confirmed = false;
          await this.repository.update(tx, next.id, {
            matchCount: { increment: 1 },
            lastMatchedAt: new Date()
          });
          await this.repository.bind(tx, numberHash, nameEncrypted, false, nameId);
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.names.match',
          objectType: 'bank_recharge_card',
          objectId: card?.id,
          afterData: { last4: number.slice(-4), nameId, confirmed },
          remark: confirmed ? '读取银行卡历史绑定姓名' : '匹配姓名库资料'
        });
        return {
          name: this.encryption.decrypt(nameEncrypted),
          confirmed,
          cardId: card?.id ?? null,
          billingAddressId: card?.billingAddressId ?? null
        };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
  async prepare(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some((key) => !['number', 'expiry', 'name', 'currencyCode'].includes(key))
    )
      throw new BadRequestException('银行卡登记资料格式无效');
    return this.transactions.execute(
      async (tx) => {
        const card = await this.prepareCard(
          tx,
          {
            number: cardNumber(input.number),
            expiry: cardExpiry(input.expiry),
            name: this.name(input.name),
            currencyCode: bankRechargeCurrency(input.currencyCode)
          },
          operator
        );
        return { cardId: card.id };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
  async localCard(tx: V2CommandTransaction, id: string, name: string, currency: string) {
    await this.repository.lock(tx);
    const card = await this.repository.cardById(tx, id);
    if (!card || !card.active || card.currencyCode !== currency || !card.numberHash)
      throw new ConflictException('所选银行卡不可用或币种不匹配');
    const binding = await this.repository.binding(tx, card.numberHash);
    for (const fixed of [
      card.billingNameEncrypted,
      binding?.confirmed ? binding.nameEncrypted : null
    ]) {
      if (fixed && this.encryption.decrypt(fixed) !== this.name(name))
        throw new ConflictException('持卡人姓名与银行卡历史绑定不一致');
    }
    return card;
  }
  async prepareCard(
    tx: V2CommandTransaction,
    value: { number: string; expiry: string; name: string; currencyCode: string },
    operator: AuthenticatedUser
  ) {
    await this.repository.lock(tx);
    const number = cardNumber(value.number);
    const numberHash = this.encryption.hash(number)!;
    const card = await this.repository.card(tx, numberHash);
    if (card && (!card.active || card.currencyCode !== value.currencyCode))
      throw new ConflictException('银行卡已停用或付款币种不匹配');
    const binding = await this.repository.binding(tx, numberHash);
    for (const fixedName of [
      card?.billingNameEncrypted,
      binding?.confirmed ? binding.nameEncrypted : null
    ]) {
      if (fixedName && this.encryption.decrypt(fixedName) !== this.name(value.name))
        throw new ConflictException('持卡人姓名与银行卡历史绑定不一致');
    }
    if (card) return card;
    const created = await this.repository.createCard(tx, {
      label: `银行卡 ····${number.slice(-4)}`,
      last4: number.slice(-4),
      numberEncrypted: this.encryption.encrypt(number),
      numberHash,
      expiry: cardExpiry(value.expiry),
      currency: { connect: { code: value.currencyCode } },
      createdByUserId: operator.id
    });
    await this.audit.append(tx, {
      userId: operator.id,
      module: 'id_business_v2',
      action: 'id_business_v2.bank_recharge.card.create_from_recharge',
      objectType: 'bank_recharge_card',
      objectId: created.id,
      afterData: { last4: created.last4, currencyCode: created.currencyCode },
      remark: '登记本次充值银行卡，成功后确认姓名绑定'
    });
    return created;
  }
  async confirm(tx: V2CommandTransaction, numberHash: string, nameEncrypted: string) {
    await this.repository.lock(tx);
    const previous = await this.repository.binding(tx, numberHash);
    if (
      previous?.confirmed &&
      this.encryption.decrypt(previous.nameEncrypted) !== this.encryption.decrypt(nameEncrypted)
    )
      throw new ConflictException('银行卡已有不同的历史绑定姓名');
    await this.repository.bind(tx, numberHash, nameEncrypted, true);
  }
}
