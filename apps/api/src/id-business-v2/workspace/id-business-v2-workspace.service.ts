import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import {
  V2_WORKSPACE_SHORTCUT_LIMITS,
  type V2WorkspaceShortcut,
  type V2WorkspaceShortcutList
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type {
  CreateIdBusinessV2WorkspaceShortcutDto,
  ReorderIdBusinessV2WorkspaceShortcutsDto,
  UpdateIdBusinessV2WorkspaceShortcutDto
} from './dto/id-business-v2-workspace-shortcut.dto';
import { IdBusinessV2WorkspaceRepository } from './persistence/id-business-v2-workspace.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdBusinessV2WorkspaceService {
  constructor(
    private readonly repository: IdBusinessV2WorkspaceRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async list(operator?: AuthenticatedUser): Promise<V2WorkspaceShortcutList> {
    const userId = this.requireUserId(operator);
    const rows = await this.repository.listByUser(userId);
    return { items: rows.map((row) => this.toResponse(row)) };
  }

  async create(
    dto: CreateIdBusinessV2WorkspaceShortcutDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-shortcut-create'
  ): Promise<V2WorkspaceShortcut> {
    const userId = this.requireUserId(operator);
    const input = this.normalizeShortcut(dto);

    const row = await this.transactionManager.execute(
      async (tx) => {
        if ((await this.repository.countByUser(userId, tx)) >= V2_WORKSPACE_SHORTCUT_LIMITS.count) {
          throw new BadRequestException(
            `每位用户最多保存 ${V2_WORKSPACE_SHORTCUT_LIMITS.count} 个快捷网址`
          );
        }
        if (await this.repository.findByUserAndUrl(userId, input.url, tx)) {
          throw new ConflictException('该快捷网址已经存在');
        }
        const created = await this.repository.create(tx, {
          userId,
          ...input,
          sortOrder: await this.repository.nextSortOrder(userId, tx)
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_shortcut.create',
          objectType: 'id_business_v2_workspace_shortcut',
          objectId: created.id,
          afterData: toV2JsonDocument(this.toAuditData(created)),
          remark: `已添加快捷网址：${created.name}`
        });
        return created;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(row);
  }

  async update(
    shortcutIdInput: unknown,
    dto: UpdateIdBusinessV2WorkspaceShortcutDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-shortcut-update'
  ): Promise<V2WorkspaceShortcut> {
    const userId = this.requireUserId(operator);
    const shortcutId = this.normalizeId(shortcutIdInput);
    const input = this.normalizeShortcut(dto);

    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(shortcutId, userId, tx);
        if (!before) throw new NotFoundException('快捷网址不存在');
        const duplicate = await this.repository.findByUserAndUrl(userId, input.url, tx);
        if (duplicate && duplicate.id !== before.id) {
          throw new ConflictException('该快捷网址已经存在');
        }
        const updated = await this.repository.update(tx, before.id, input);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_shortcut.update',
          objectType: 'id_business_v2_workspace_shortcut',
          objectId: updated.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument(this.toAuditData(updated)),
          remark: `已修改快捷网址：${updated.name}`
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(row);
  }

  async remove(
    shortcutIdInput: unknown,
    operator?: AuthenticatedUser,
    requestId = 'workspace-shortcut-delete'
  ) {
    const userId = this.requireUserId(operator);
    const shortcutId = this.normalizeId(shortcutIdInput);

    return this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(shortcutId, userId, tx);
        if (!before) throw new NotFoundException('快捷网址不存在');
        await this.repository.remove(tx, before.id);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_shortcut.delete',
          objectType: 'id_business_v2_workspace_shortcut',
          objectId: before.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument({ deleted: true }),
          remark: `已删除快捷网址：${before.name}`
        });
        return { id: before.id, deleted: true as const };
      },
      { requestId, operator, retryMode: 'none' }
    );
  }

  async reorder(
    dto: ReorderIdBusinessV2WorkspaceShortcutsDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-shortcut-reorder'
  ): Promise<V2WorkspaceShortcutList> {
    const userId = this.requireUserId(operator);
    const shortcutIds = this.normalizeShortcutIds(dto.shortcutIds);

    const rows = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.listByUser(userId, tx);
        if (
          before.length !== shortcutIds.length ||
          before.some((row) => !shortcutIds.includes(row.id))
        ) {
          throw new BadRequestException('快捷网址排序范围无效，请刷新后重试');
        }
        if (before.every((row, index) => row.id === shortcutIds[index])) return before;
        const updated = await this.repository.updateOrder(tx, userId, shortcutIds);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_shortcut.reorder',
          objectType: 'id_business_v2_workspace_shortcut',
          objectId: userId,
          beforeData: toV2JsonDocument({ shortcutIds: before.map((row) => row.id) }),
          afterData: toV2JsonDocument({ shortcutIds }),
          remark: '已调整个人工作区快捷网址顺序'
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return { items: rows.map((row) => this.toResponse(row)) };
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }

  private normalizeId(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException('快捷网址标识无效');
    }
    return value;
  }

  private normalizeShortcut(dto: { name?: unknown; url?: unknown }) {
    if (typeof dto.name !== 'string') throw new BadRequestException('请输入网址名称');
    const name = dto.name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > V2_WORKSPACE_SHORTCUT_LIMITS.name) {
      throw new BadRequestException(
        `网址名称长度必须为 1 至 ${V2_WORKSPACE_SHORTCUT_LIMITS.name} 个字符`
      );
    }
    return { name, url: this.normalizeUrl(dto.url) };
  }

  private normalizeUrl(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入网址');
    const raw = value.trim();
    if (
      !raw ||
      Array.from(raw).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException('网址格式无效');
    }
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new BadRequestException('网址格式无效');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new BadRequestException('只允许添加 HTTP 或 HTTPS 网址');
    }
    if (parsed.username || parsed.password) {
      throw new BadRequestException('网址中不能包含账号或密码');
    }
    const normalized = parsed.toString();
    if (normalized.length > V2_WORKSPACE_SHORTCUT_LIMITS.url) {
      throw new BadRequestException(`网址最多 ${V2_WORKSPACE_SHORTCUT_LIMITS.url} 个字符`);
    }
    return normalized;
  }

  private normalizeShortcutIds(value: unknown) {
    if (!Array.isArray(value) || value.length > V2_WORKSPACE_SHORTCUT_LIMITS.count) {
      throw new BadRequestException('快捷网址排序范围无效');
    }
    const ids = value.map((item) => this.normalizeId(item));
    if (new Set(ids).size !== ids.length) throw new BadRequestException('快捷网址排序存在重复项');
    return ids;
  }

  private toAuditData(row: { name: string; url: string; sortOrder: number }) {
    return { name: row.name, origin: new URL(row.url).origin, sortOrder: row.sortOrder };
  }

  private toResponse(row: {
    id: string;
    name: string;
    url: string;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }): V2WorkspaceShortcut {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}
