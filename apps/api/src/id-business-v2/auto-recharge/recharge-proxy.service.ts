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
  type V2CommandTransaction
} from '../runtime/public-api';
import { bankRechargeId, bankRechargeObject, bankRechargeText } from './bank-recharge-validation';
import { RechargeProxyRepository } from './persistence/recharge-proxy.repository';
import {
  parseRechargeProxy,
  rechargeProxyConnection,
  proxyCountry,
  proxyKind,
  proxyLink,
  proxyProtocol,
  type RechargeProxyKind
} from './recharge-proxy-validation';

type ManagedProxyInput = ReturnType<typeof parseRechargeProxy>;

@Injectable()
export class RechargeProxyService {
  constructor(
    private readonly repository: RechargeProxyRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async list(
    query: {
      page?: string;
      pageSize?: string;
      keyword?: string;
      countryCode?: string;
      kind?: string;
      status?: string;
    } = {}
  ) {
    const pagination = getPagination(query);
    const keyword = bankRechargeText(query.keyword, '搜索内容', 160, false);
    const countryCode = query.countryCode ? proxyCountry(query.countryCode) : '';
    const kind = query.kind ? proxyKind(query.kind) : '';
    const status = bankRechargeText(query.status, '代理状态', 16, false);
    if (status && status !== 'active' && status !== 'disabled') {
      throw new BadRequestException('代理状态无效');
    }
    const where = {
      ...(countryCode ? { countryCode } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { active: status === 'active' } : {}),
      ...(keyword
        ? {
            OR: [
              { countryCode: { contains: keyword } },
              { remark1: { contains: keyword } },
              { remark2: { contains: keyword } }
            ]
          }
        : {})
    };
    const [items, total] = await Promise.all([
      this.repository.list(where, pagination.skip, pagination.take),
      this.repository.count(where)
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        countryCode: item.countryCode,
        kind: item.kind,
        connectionMode: item.connectionMode,
        protocol: item.protocol,
        linkMask: `已保存 ···${item.urlHash.slice(-6)}`,
        status: item.active ? 'active' : 'disabled',
        remark1: item.remark1,
        remark2: item.remark2,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async countries() {
    const rows = await this.repository.activeCountries();
    return { items: rows.map((row) => row.countryCode) };
  }

  async detail(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, '代理编号');
    return this.transactions.execute(
      async (tx) => {
        const item = await this.repository.findInTransaction(tx, id);
        if (!item) throw new NotFoundException('代理 IP 不存在');
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.proxy.link_read',
          objectType: 'recharge_proxy',
          objectId: id,
          afterData: { countryCode: item.countryCode, kind: item.kind },
          remark: '查看代理 IP 完整链接'
        });
        return {
          id: item.id,
          countryCode: item.countryCode,
          kind: item.kind,
          connectionMode: item.connectionMode,
          protocol: item.protocol,
          url: this.encryption.decrypt(item.urlEncrypted),
          status: item.active ? 'active' : 'disabled',
          remark1: item.remark1,
          remark2: item.remark2
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  private async insert(
    tx: V2CommandTransaction,
    input: ManagedProxyInput,
    operator: AuthenticatedUser
  ) {
    const item = await this.repository.create(tx, {
      countryCode: input.countryCode,
      kind: input.kind,
      connectionMode: input.connectionMode,
      protocol: input.protocol,
      urlEncrypted: this.encryption.encrypt(input.url)!,
      urlHash: this.encryption.hash(input.url)!,
      remark1: input.remark1 || null,
      remark2: input.remark2 || null,
      createdByUserId: operator.id
    });
    await this.audit.append(tx, {
      userId: operator.id,
      module: 'id_business_v2',
      action: 'id_business_v2.auto_recharge.proxy.create',
      objectType: 'recharge_proxy',
      objectId: item.id,
      afterData: { countryCode: item.countryCode, kind: item.kind },
      remark: '新增充值代理 IP'
    });
    return { id: item.id };
  }

  async create(value: unknown, operator: AuthenticatedUser) {
    const input = parseRechargeProxy(value);
    return this.transactions.execute((tx) => this.insert(tx, input, operator), {
      changedScopes: ['auto-recharge'],
      requestId: randomUUID(),
      operator,
      retryMode: 'none',
      uniqueConflictMessage: '该代理 IP 链接已保存'
    });
  }

  async importMany(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    if (!Array.isArray(input.proxies) || input.proxies.length < 1 || input.proxies.length > 100) {
      throw new BadRequestException('每次只能导入 1 至 100 条代理 IP');
    }
    const proxies = input.proxies.map((row: unknown, index: number) => {
      try {
        return parseRechargeProxy(row);
      } catch {
        throw new BadRequestException(`第 ${index + 1} 行代理 IP 资料无效`);
      }
    });
    if (new Set(proxies.map((proxy) => proxy.url)).size !== proxies.length) {
      throw new BadRequestException('导入内容包含重复代理 IP 链接');
    }
    return this.transactions.execute(
      async (tx) => {
        for (const proxy of proxies) await this.insert(tx, proxy, operator);
        return { imported: proxies.length };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        timeoutMs: 60_000,
        uniqueConflictMessage: '部分代理 IP 链接已保存，整批未导入'
      }
    );
  }

  async update(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '代理编号');
    const input = bankRechargeObject(value);
    if (
      !Object.keys(input).length ||
      Object.keys(input).some(
        (key) =>
          !['countryCode', 'kind', 'url', 'protocol', 'status', 'remark1', 'remark2'].includes(key)
      )
    ) {
      throw new BadRequestException('代理 IP 资料包含不支持的字段');
    }
    const countryCode =
      input.countryCode === undefined ? undefined : proxyCountry(input.countryCode);
    const kind = input.kind === undefined ? undefined : proxyKind(input.kind);
    const protocol = input.protocol === undefined ? undefined : proxyProtocol(input.protocol);
    const link =
      input.url === undefined || input.url === '' ? undefined : proxyLink(input.url, protocol);
    const remark1 =
      input.remark1 === undefined
        ? undefined
        : bankRechargeText(input.remark1, '备注1', 500, false);
    const remark2 =
      input.remark2 === undefined
        ? undefined
        : bankRechargeText(input.remark2, '备注2', 500, false);
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'disabled') {
      throw new BadRequestException('代理状态无效');
    }
    return this.transactions.execute(
      async (tx) => {
        const previous = await this.repository.findInTransaction(tx, id);
        if (!previous) throw new NotFoundException('代理 IP 不存在');
        const linkChanged = Boolean(link && this.encryption.hash(link.url) !== previous.urlHash);
        const nextProtocol =
          link?.connectionMode === 'direct' ? link.protocol : (protocol ?? previous.protocol);
        if (
          !link &&
          protocol &&
          previous.connectionMode === 'direct' &&
          protocol !== previous.protocol
        ) {
          throw new BadRequestException('更换直连代理协议时请同时填写对应协议的链接');
        }
        const protocolChanged = nextProtocol !== previous.protocol;
        if (
          (linkChanged ||
            protocolChanged ||
            (countryCode && countryCode !== previous.countryCode) ||
            (kind && kind !== previous.kind)) &&
          (await this.repository.hasJobs(tx, id))
        ) {
          throw new ConflictException(
            '代理 IP 已用于充值任务，不能更换国家、属性、协议或链接；请新增代理'
          );
        }
        await this.repository.update(tx, id, {
          ...(countryCode ? { countryCode } : {}),
          ...(kind ? { kind } : {}),
          ...(protocolChanged ? { protocol: nextProtocol } : {}),
          ...(linkChanged && link
            ? {
                urlEncrypted: this.encryption.encrypt(link.url)!,
                urlHash: this.encryption.hash(link.url)!,
                connectionMode: link.connectionMode,
                protocol: nextProtocol
              }
            : {}),
          ...(remark1 !== undefined ? { remark1: remark1 || null } : {}),
          ...(remark2 !== undefined ? { remark2: remark2 || null } : {}),
          ...(input.status ? { active: input.status === 'active' } : {})
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.proxy.update',
          objectType: 'recharge_proxy',
          objectId: id,
          beforeData: {
            countryCode: previous.countryCode,
            kind: previous.kind,
            protocol: previous.protocol,
            active: previous.active
          },
          afterData: {
            countryCode: countryCode ?? previous.countryCode,
            kind: kind ?? previous.kind,
            protocol: nextProtocol,
            active: input.status ? input.status === 'active' : previous.active,
            linkChanged
          },
          remark: '修改充值代理 IP'
        });
        return { id };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该代理 IP 链接已保存'
      }
    );
  }

  async delete(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, '代理编号');
    return this.transactions.execute(
      async (tx) => {
        const item = await this.repository.findInTransaction(tx, id);
        if (!item) throw new NotFoundException('代理 IP 不存在');
        if (await this.repository.hasJobs(tx, id)) {
          throw new ConflictException('代理 IP 已用于充值任务，请改为停用');
        }
        await this.repository.delete(tx, id);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.proxy.delete',
          objectType: 'recharge_proxy',
          objectId: id,
          beforeData: { countryCode: item.countryCode, kind: item.kind },
          remark: '删除未使用的充值代理 IP'
        });
        return { id };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async forCharge(id: string, operator: AuthenticatedUser, countryCode?: string) {
    bankRechargeId(id, '代理编号');
    const item = await this.transactions.execute(
      async (tx) => {
        const row = await this.repository.findInTransaction(tx, id);
        if (!row || !row.active) throw new ConflictException('所选代理 IP 已停用或不存在');
        if (countryCode && row.countryCode !== countryCode) {
          throw new ConflictException('所选代理 IP 与本次国家不一致');
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.proxy.use',
          objectType: 'recharge_proxy',
          objectId: id,
          afterData: { countryCode: row.countryCode, kind: row.kind },
          remark: '单笔充值使用已保存代理 IP'
        });
        return row;
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
    const url = this.encryption.decrypt(item.urlEncrypted)!;
    return {
      id: item.id,
      countryCode: item.countryCode,
      kind: item.kind as RechargeProxyKind,
      ...rechargeProxyConnection(url, item.connectionMode, proxyProtocol(item.protocol))
    };
  }
}
