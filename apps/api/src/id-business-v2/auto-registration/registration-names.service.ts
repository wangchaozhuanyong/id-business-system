import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination } from '../../common/pagination';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { id, record, text } from './registration-validation';

@Injectable()
export class RegistrationNamesService {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}
  async list(query: { page?: string; pageSize?: string; keyword?: string; status?: string }) {
    const p = getPagination(query);
    if (query.status && !['all', 'active', 'disabled'].includes(query.status))
      throw new BadRequestException('姓名状态无效');
    const where = {
      ...(query.keyword ? { displayName: { contains: text(query.keyword, '搜索内容') } } : {}),
      ...(query.status && query.status !== 'all' ? { active: query.status === 'active' } : {})
    };
    const [items, total] = await Promise.all([
      this.repository.names(where, p.skip, p.take),
      this.repository.countNames(where)
    ]);
    return { items, total, page: p.page, pageSize: p.pageSize };
  }
  async write(nameId: string | null, value: unknown, operator: AuthenticatedUser) {
    if (nameId) id(nameId);
    const input = record(value);
    if (
      Object.keys(input).some(
        (key) => !['displayName', 'active', 'expectedUpdatedAt'].includes(key)
      ) ||
      typeof input.active !== 'boolean'
    )
      throw new BadRequestException('姓名资料无效');
    const displayName = text(input.displayName, '名字');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        if (nameId && input.expectedUpdatedAt) {
          const current = await this.repository.findName(tx, nameId);
          if (!current || current.updatedAt.toISOString() !== input.expectedUpdatedAt)
            throw new ConflictException('姓名已被修改，请重新核对');
        }
        const item = await this.repository.writeName(tx, nameId, {
          displayName,
          active: input.active as boolean
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: `id_business_v2.auto_registration.name.${nameId ? 'update' : 'create'}`,
          objectType: 'registration_name',
          objectId: item.id,
          afterData: { name: displayName, active: item.active }
        });
        return item;
      },
      {
        changedScopes: ['auto-recharge'],
        operator,
        requestId: randomUUID(),
        retryMode: 'none',
        uniqueConflictMessage: '该名字已存在'
      }
    );
  }
  async import(value: unknown, operator: AuthenticatedUser) {
    const input = record(value);
    if (
      Object.keys(input).some((key) => key !== 'names') ||
      !Array.isArray(input.names) ||
      input.names.length < 1 ||
      input.names.length > 500
    )
      throw new BadRequestException('每次导入 1 至 500 个名字');
    const inputCount = input.names.length;
    const names = [...new Set(input.names.map((name) => text(name, '名字')))];
    return this.transactions.execute(
      async (tx) => {
        const result = await this.repository.importNames(tx, names);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.name.import',
          objectType: 'registration_name',
          afterData: { imported: result.count, skipped: inputCount - result.count }
        });
        return { imported: result.count, skipped: inputCount - result.count };
      },
      { changedScopes: ['auto-recharge'], operator, requestId: randomUUID(), retryMode: 'none' }
    );
  }
}
