import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { V2QuickActionList } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import {
  clearLegacyQuickActionOrder,
  readQuickActionOrder,
  sortQuickActions
} from './quickActionOrder';

export function useV2QuickActions(options: {
  userId: () => string;
  writesAllowed: () => boolean;
  open: Ref<boolean>;
}) {
  const migrationError = ref('');
  const savingOrder = ref(false);
  let disposed = false;
  let writeRevision = 0;
  let legacyMigrationAllowed = true;
  let legacyMigrationConfirmed = false;
  const key = () => `quick-actions:${options.userId() || 'anonymous'}`;
  const isCurrent = (userId: string, epoch: number) =>
    !disposed && options.userId() === userId && sessionCoordinator.identityEpoch.value === epoch;
  const cancelled = () => new DOMException('登录身份已变化，本次顺序结果未显示。', 'AbortError');

  watch(
    () => sessionCoordinator.identityEpoch.value,
    () => {
      writeRevision += 1;
      savingOrder.value = false;
      migrationError.value = '';
      legacyMigrationAllowed = true;
      legacyMigrationConfirmed = false;
      options.open.value = false;
    }
  );

  const query = useV2ModuleQuery<V2QuickActionList>({
    moduleKey: 'profile',
    scope: 'workspace',
    key,
    enabled: () => options.open.value && Boolean(options.userId()),
    trackRouteData: false,
    query: async ({ signal }) => {
      const userId = options.userId();
      const epoch = sessionCoordinator.identityEpoch.value;
      const result = await idBusinessV2WorkspaceApi.listQuickActions({ signal });
      if (signal.aborted || !isCurrent(userId, epoch)) throw cancelled();
      if (result.hasCustomOrder === true) {
        legacyMigrationConfirmed = true;
        migrationError.value = '';
        clearLegacyQuickActionOrder(userId);
        return result;
      }
      // An older API may not support database ordering yet; never silently write browser storage.
      if (result.hasCustomOrder !== false) return result;
      const legacyIds = readQuickActionOrder(userId);
      if (!result.items.some((item) => legacyIds.includes(item.id))) {
        migrationError.value = '';
        return result;
      }
      if (!legacyMigrationAllowed) return result;
      if (!options.writesAllowed()) {
        migrationError.value = '原浏览器顺序尚未同步，恢复连接后可点击重试同步。';
        return result;
      }
      legacyMigrationAllowed = false;
      migrationError.value = '';
      try {
        const updated = await idBusinessV2WorkspaceApi.reorderQuickActions({
          quickActionIds: sortQuickActions(result.items, legacyIds).map((item) => item.id),
          expectedQuickActionIds: result.items.map((item) => item.id),
          initializeOnly: true
        });
        if (signal.aborted || !isCurrent(userId, epoch)) throw cancelled();
        if (updated.hasCustomOrder !== true) throw new Error('服务器尚未确认顺序，请稍后重试');
        legacyMigrationConfirmed = true;
        clearLegacyQuickActionOrder(userId);
        return updated;
      } catch (error) {
        if (!isCurrent(userId, epoch)) throw cancelled();
        // Closing the drawer cancels its read, but the initialization write may still fail/commit.
        // Retain an explicit retry notice until a later database read confirms the saved order.
        if (!legacyMigrationConfirmed) {
          migrationError.value = signal.aborted
            ? '原浏览器顺序尚未确认同步，请点击重试同步。'
            : `原浏览器顺序同步失败：${getApiErrorMessage(error)}`;
        }
        if (signal.aborted) throw cancelled();
        return result;
      }
    }
  });
  const items = computed(() => query.data.value?.items ?? []);

  async function refresh() {
    // A failed migration can only be attempted again after an explicit retry from the user.
    legacyMigrationAllowed = true;
    await query.refresh();
  }

  async function reorder(quickActionIds: string[]) {
    if (!options.writesAllowed()) throw new Error('当前连接处于只读状态，恢复后请重试');
    if (savingOrder.value) throw new Error('正在保存顺序，请稍候');
    if (query.phase.value !== 'ready' || !query.hasCurrentData.value)
      throw new Error('请先读取最新回复列表，再调整顺序');
    if (query.data.value?.hasCustomOrder === undefined)
      throw new Error('服务器尚未支持顺序同步，请更新系统后刷新');
    const userId = options.userId();
    const epoch = sessionCoordinator.identityEpoch.value;
    const revision = ++writeRevision;
    const expectedQuickActionIds = items.value.map((item) => item.id);
    savingOrder.value = true;
    try {
      const updated = await idBusinessV2WorkspaceApi.reorderQuickActions({
        quickActionIds,
        expectedQuickActionIds
      });
      if (!isCurrent(userId, epoch)) throw cancelled();
      if (updated.hasCustomOrder !== true) throw new Error('服务器尚未确认顺序，请刷新后重试');
      legacyMigrationConfirmed = true;
      primeV2Query({ scope: 'workspace', key: key(), data: updated });
      clearLegacyQuickActionOrder(userId);
      migrationError.value = '';
    } catch (error) {
      if (!isCurrent(userId, epoch)) throw cancelled();
      // A failed/ambiguous write is never replayed. Re-read the committed order before another drag.
      legacyMigrationAllowed = false;
      await query.refresh();
      if (!isCurrent(userId, epoch)) throw cancelled();
      throw new Error(getApiErrorMessage(error), { cause: error });
    } finally {
      if (isCurrent(userId, epoch) && revision === writeRevision) savingOrder.value = false;
    }
  }

  onScopeDispose(() => {
    disposed = true;
    writeRevision += 1;
  });
  return { query, items, migrationError, savingOrder, reorder, refresh };
}
