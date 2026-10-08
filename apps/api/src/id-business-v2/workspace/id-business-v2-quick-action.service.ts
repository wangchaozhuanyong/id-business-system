import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import {
  V2_QUICK_ACTION_LIMITS,
  type V2QuickActionItem,
  type V2QuickActionList
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type {
  IdBusinessV2QuickActionDto,
  ReorderIdBusinessV2QuickActionsDto
} from './dto/id-business-v2-quick-action.dto';
import { IdBusinessV2QuickActionRepository } from './persistence/id-business-v2-quick-action.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface QuickActionRow {
  id: string;
  title: string;
  content: string;
  sortOrder: number | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class IdBusinessV2QuickActionService {
  constructor(
    private readonly repository: IdBusinessV2QuickActionRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async list(operator?: AuthenticatedUser): Promise<V2QuickActionList> {
    const userId = this.requireUserId(operator);
    const rows = await this.repository.listByUser(userId);
    return this.toListResponse(rows);
  }

  async reorder(
    dto: ReorderIdBusinessV2QuickActionsDto,
    operator?: AuthenticatedUser,
    requestId = 'quick-action-reorder'
  ): Promise<V2QuickActionList> {
    const userId = this.requireUserId(operator);
    const quickActionIds = this.normalizeOrderIds(dto?.quickActionIds);
    const expectedQuickActionIds = this.normalizeOrderIds(dto?.expectedQuickActionIds);
    if (dto.initializeOnly !== undefined && typeof dto.initializeOnly !== 'boolean') {
      throw new BadRequestException('快捷回复初始化选项无效');
    }

    const rows = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.listByUser(userId, tx);
        // A second device must never replace an order already initialized in the database.
        if (dto.initializeOnly && before.some((row) => row.sortOrder !== null)) return before;
        const currentIds = before.map((row) => row.id);
        const matchesCurrentSet = (ids: string[]) =>
          ids.length === currentIds.length && currentIds.every((id) => ids.includes(id));
        if (!matchesCurrentSet(quickActionIds) || !matchesCurrentSet(expectedQuickActionIds)) {
          throw new ConflictException('快捷回复列表已变化，请刷新后重新排序');
        }
        if (currentIds.some((id, index) => id !== expectedQuickActionIds[index])) {
          throw new ConflictException('快捷回复顺序已被修改，请刷新后重新排序');
        }
        if (
          before.some((row) => row.sortOrder !== null) &&
          currentIds.every((id, index) => id === quickActionIds[index])
        ) {
          return before;
        }
        if (!before.length) return before;
        const rowsById = new Map(before.map((row) => [row.id, row]));
        const orderedRows = quickActionIds.map((id) => rowsById.get(id)!);
        const updated = await this.repository.updateOrder(tx, userId, orderedRows);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.quick_action.reorder',
          objectType: 'id_business_v2_quick_action',
          objectId: userId,
          beforeData: toV2JsonDocument({ quickActionIds: currentIds }),
          afterData: toV2JsonDocument({ quickActionIds }),
          remark: '已调整个人快捷回复顺序'
        });
        return updated;
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );
    return this.toListResponse(rows);
  }

  async create(
    dto: IdBusinessV2QuickActionDto,
    operator?: AuthenticatedUser,
    requestId = 'quick-action-create'
  ): Promise<V2QuickActionItem> {
    const userId = this.requireUserId(operator);
    const input = this.normalizeInput(dto);
    const row = await this.transactionManager.execute(
      async (tx) => {
        if ((await this.repository.countByUser(userId, tx)) >= V2_QUICK_ACTION_LIMITS.count) {
          throw new BadRequestException(
            `每位用户最多保存 ${V2_QUICK_ACTION_LIMITS.count} 条便捷操作`
          );
        }
        const created = await this.repository.create(tx, {
          userId,
          ...input,
          sortOrder: await this.repository.nextSortOrder(userId, tx)
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.quick_action.create',
          objectType: 'id_business_v2_quick_action',
          objectId: created.id,
          afterData: toV2JsonDocument(this.toAuditData(created)),
          remark: '已新增便捷操作'
        });
        return created;
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );
    return this.toResponse(row);
  }

  async update(
    idInput: unknown,
    dto: IdBusinessV2QuickActionDto,
    operator?: AuthenticatedUser,
    requestId = 'quick-action-update'
  ): Promise<V2QuickActionItem> {
    const userId = this.requireUserId(operator);
    const id = this.normalizeId(idInput);
    const input = this.normalizeInput(dto);
    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(id, userId, tx);
        if (!before) throw new NotFoundException('便捷操作不存在');
        const updated = await this.repository.update(tx, id, input);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.quick_action.update',
          objectType: 'id_business_v2_quick_action',
          objectId: id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument(this.toAuditData(updated)),
          remark: '已修改便捷操作'
        });
        return updated;
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );
    return this.toResponse(row);
  }

  async remove(idInput: unknown, operator?: AuthenticatedUser, requestId = 'quick-action-delete') {
    const userId = this.requireUserId(operator);
    const id = this.normalizeId(idInput);
    return this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(id, userId, tx);
        if (!before) throw new NotFoundException('便捷操作不存在');
        await this.repository.softDelete(tx, id);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.quick_action.delete',
          objectType: 'id_business_v2_quick_action',
          objectId: id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument({ deleted: true }),
          remark: '已删除便捷操作'
        });
        return { id, deleted: true as const };
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }

  private normalizeId(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException('便捷操作标识无效');
    }
    return value;
  }

  private normalizeOrderIds(value: unknown) {
    if (!Array.isArray(value) || value.length > V2_QUICK_ACTION_LIMITS.count) {
      throw new BadRequestException('快捷回复排序范围无效');
    }
    const ids = value.map((item) => this.normalizeId(item).toLowerCase());
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('快捷回复排序存在重复项');
    }
    return ids;
  }

  private normalizeInput(dto: IdBusinessV2QuickActionDto) {
    if (typeof dto.title !== 'string') throw new BadRequestException('请输入标题');
    if (typeof dto.content !== 'string') throw new BadRequestException('请输入内容');
    const title = dto.title.trim().replace(/\s+/g, ' ');
    const content = dto.content.replace(/\r\n?/g, '\n');
    if (!title || title.length > V2_QUICK_ACTION_LIMITS.title) {
      throw new BadRequestException(`标题长度必须为 1 至 ${V2_QUICK_ACTION_LIMITS.title} 个字符`);
    }
    if (!content.trim() || content.length > V2_QUICK_ACTION_LIMITS.content) {
      throw new BadRequestException(`内容长度必须为 1 至 ${V2_QUICK_ACTION_LIMITS.content} 个字符`);
    }
    return { title, content };
  }

  private toAuditData(row: { title: string; content: string }) {
    return { titleLength: row.title.length, contentLength: row.content.length };
  }

  private toListResponse(rows: QuickActionRow[]): V2QuickActionList {
    return {
      items: rows.map((row) => this.toResponse(row)),
      hasCustomOrder: rows.some((row) => row.sortOrder !== null)
    };
  }

  private toResponse(row: QuickActionRow): V2QuickActionItem {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}
