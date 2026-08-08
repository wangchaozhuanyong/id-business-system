import { BadRequestException, Injectable } from '@nestjs/common';
import {
  V2_TABLE_PREFERENCE_LIMITS,
  type ResetV2TablePreferenceResult,
  type V2TablePreference,
  type V2TablePreferenceList
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type { UpdateIdBusinessV2TablePreferenceDto } from './dto/update-id-business-v2-table-preference.dto';
import { IdBusinessV2TablePreferencesRepository } from './persistence/id-business-v2-table-preferences.repository';

const TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

@Injectable()
export class IdBusinessV2TablePreferencesService {
  constructor(
    private readonly repository: IdBusinessV2TablePreferencesRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async list(operator?: AuthenticatedUser): Promise<V2TablePreferenceList> {
    const userId = this.requireUserId(operator);
    const rows = await this.repository.listByUser(userId);
    return { items: rows.map((row) => this.toResponse(row)) };
  }

  async update(
    tableIdInput: unknown,
    dto: UpdateIdBusinessV2TablePreferenceDto,
    operator?: AuthenticatedUser,
    requestId = 'table-preference-update'
  ): Promise<V2TablePreference> {
    const userId = this.requireUserId(operator);
    const tableId = this.normalizeTableId(tableIdInput);
    const hiddenColumnKeys = this.normalizeHiddenColumnKeys(dto.hiddenColumnKeys);

    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByUserAndTable(userId, tableId, tx);
        const updated = await this.repository.upsert(tx, { userId, tableId, hiddenColumnKeys });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.table_preferences.update',
          objectType: 'id_business_v2_user_table_preference',
          objectId: updated.id,
          beforeData: before
            ? toV2JsonDocument({
                tableId: before.tableId,
                hiddenColumnKeys: this.readHiddenColumnKeys(before.hiddenColumnKeys)
              })
            : undefined,
          afterData: toV2JsonDocument({ tableId, hiddenColumnKeys }),
          remark: `已保存数据表 ${tableId} 的列显示设置`
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(row);
  }

  async reset(
    tableIdInput: unknown,
    operator?: AuthenticatedUser,
    requestId = 'table-preference-reset'
  ): Promise<ResetV2TablePreferenceResult> {
    const userId = this.requireUserId(operator);
    const tableId = this.normalizeTableId(tableIdInput);

    const deleted = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByUserAndTable(userId, tableId, tx);
        if (!before) return false;
        await this.repository.remove(tx, before.id);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.table_preferences.reset',
          objectType: 'id_business_v2_user_table_preference',
          objectId: before.id,
          beforeData: toV2JsonDocument({
            tableId: before.tableId,
            hiddenColumnKeys: this.readHiddenColumnKeys(before.hiddenColumnKeys)
          }),
          afterData: toV2JsonDocument({ tableId, hiddenColumnKeys: [] }),
          remark: `已恢复数据表 ${tableId} 的默认列设置`
        });
        return true;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return { tableId, hiddenColumnKeys: [], deleted };
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }

  private normalizeTableId(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('数据表标识无效');
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > V2_TABLE_PREFERENCE_LIMITS.tableId ||
      !TABLE_ID_PATTERN.test(normalized)
    ) {
      throw new BadRequestException('数据表标识无效');
    }
    return normalized;
  }

  private normalizeHiddenColumnKeys(value: unknown) {
    if (!Array.isArray(value)) throw new BadRequestException('隐藏列设置必须是数组');
    if (value.length > V2_TABLE_PREFERENCE_LIMITS.hiddenColumnCount) {
      throw new BadRequestException(
        `单张表最多保存 ${V2_TABLE_PREFERENCE_LIMITS.hiddenColumnCount} 个隐藏列`
      );
    }

    const keys = value.map((item) => {
      if (typeof item !== 'string') throw new BadRequestException('隐藏列标识必须是文本');
      const normalized = item.trim();
      if (
        !normalized ||
        normalized.length > V2_TABLE_PREFERENCE_LIMITS.columnKey ||
        Array.from(normalized).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        })
      ) {
        throw new BadRequestException('隐藏列标识无效');
      }
      return normalized;
    });

    return [...new Set(keys)];
  }

  private readHiddenColumnKeys(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }

  private toResponse(row: {
    tableId: string;
    hiddenColumnKeys: unknown;
    updatedAt: Date;
  }): V2TablePreference {
    return {
      tableId: row.tableId,
      hiddenColumnKeys: this.readHiddenColumnKeys(row.hiddenColumnKeys),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}
