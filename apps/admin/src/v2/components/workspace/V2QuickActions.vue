<template>
  <section class="v2-quick-actions-panel" aria-label="话术文案">
    <div class="v2-quick-actions-panel__toolbar">
      <el-input
        v-model="keyword"
        :disabled="mutationPending"
        clearable
        maxlength="100"
        placeholder="搜索文案"
        aria-label="搜索话术标题或内容"
      />
      <el-dropdown trigger="click" :disabled="mutationPending" @command="changeSort">
        <AppButton :disabled="mutationPending" :title="`话术排序：${sortLabel}`">
          排序<el-icon aria-hidden="true"><ArrowDown /></el-icon>
        </AppButton>
        <template #dropdown>
          <el-dropdown-menu aria-label="话术文案排序">
            <el-dropdown-item
              v-for="option in sortOptions"
              :key="option.value"
              :command="option.value"
              :disabled="sort === option.value"
            >
              {{ option.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <AppButton
        variant="primary"
        :disabled="!auth.writesAllowed || mutationPending || limitReached"
        @click="drawer?.startCreate()"
      >
        新增
      </AppButton>
    </div>

    <p v-if="migrationError" class="v2-quick-actions-panel__notice" role="alert">
      {{ migrationError }}
      <AppButton
        variant="ghost"
        size="small"
        :disabled="!auth.writesAllowed || mutationPending || query.phase.value !== 'ready'"
        @click="refresh"
        >重试同步</AppButton
      >
    </p>
    <p v-if="!auth.writesAllowed" class="v2-quick-actions-panel__notice" role="status">
      当前连接处于只读状态，恢复后才能修改话术文案。
    </p>
    <p v-else-if="limitReached" class="v2-quick-actions-panel__notice" role="status">
      已达到每人 {{ V2_QUICK_ACTION_LIMITS.count }} 条的上限。
    </p>
    <p v-if="canReorder" class="v2-quick-actions-panel__notice">
      拖动卡片空白处或标题调整顺序，松开后自动保存。
    </p>
    <p v-else-if="sort !== 'custom'" class="v2-quick-actions-panel__notice">
      选择“自定义排序”后可拖动卡片调整顺序。
    </p>
    <p v-else-if="keyword.trim()" class="v2-quick-actions-panel__notice">
      清空搜索后可拖动卡片调整完整顺序。
    </p>
    <p v-if="ordering" class="v2-quick-actions-panel__notice" role="status">正在保存顺序…</p>

    <V2AsyncRegion
      :phase="query.phase.value"
      :empty="items.length === 0"
      :error="queryError"
      variant="section"
      skeleton="inline"
      loading-title="正在读取话术文案"
      refreshing-title="正在更新话术文案"
      empty-title="还没有话术文案"
      empty-message="新增后可一键复制正文。"
      error-title="话术文案加载失败"
      @retry="refresh"
    >
      <template #empty-action>
        <AppButton v-if="auth.writesAllowed" variant="primary" @click="drawer?.startCreate()">
          新增第一条
        </AppButton>
      </template>
      <p v-if="!filteredItems.length" class="v2-quick-actions-panel__notice">
        没有匹配的话术文案，请调整搜索词。
      </p>
      <div
        v-else
        ref="cardsScroll"
        class="v2-quick-actions-panel__list v2-quick-actions-drawer__cards"
        @pointermove="moveDrag"
        @pointerup="finishDrag"
        @pointercancel="cancelDrag"
        @lostpointercapture="cancelDrag"
      >
        <article
          v-for="item in pageItems"
          :key="item.id"
          class="v2-quick-actions-panel__item v2-quick-actions-drawer__card"
          :class="[rowClass({ row: item }), { 'is-draggable': canReorder }]"
          @pointerdown="startCardDrag($event, item.id)"
        >
          <button
            v-if="sort === 'custom'"
            class="v2-quick-actions-panel__title v2-quick-actions-panel__drag-title"
            type="button"
            :disabled="!canReorder"
            :aria-label="`调整顺序：${item.title}`"
            :title="`${item.title}；拖动标题或使用上下方向键调整顺序`"
            :data-sort-id="item.id"
            @keydown="moveWithKeyboard($event, item.id)"
          >
            <el-icon aria-hidden="true"><Rank /></el-icon>
            <span>{{ item.title }}</span>
          </button>
          <span v-else class="v2-quick-actions-panel__title" :title="item.title">
            {{ item.title }}
          </span>
          <AppButton size="small" variant="soft" @click="drawer?.copyContent(item)">
            复制文案
          </AppButton>
          <el-dropdown
            trigger="click"
            :disabled="mutationPending"
            @command="handleItemCommand($event, item)"
          >
            <AppButton
              size="small"
              variant="ghost"
              :disabled="mutationPending"
              :aria-label="`更多：${item.title}`"
              >更多</AppButton
            >
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="read">查看全文</el-dropdown-item>
                <el-dropdown-item command="edit" :disabled="!auth.writesAllowed">
                  编辑文案
                </el-dropdown-item>
                <el-dropdown-item command="delete" :disabled="!auth.writesAllowed" divided>
                  删除文案
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </article>
      </div>
      <el-pagination
        v-if="sort !== 'custom' && filteredItems.length > pageSize"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="filteredItems.length"
        layout="prev, pager, next"
        size="small"
        aria-label="话术文案分页"
      />
    </V2AsyncRegion>

    <V2QuickActionsDrawer
      ref="drawer"
      v-model="drawerOpen"
      :items="items"
      :phase="query.phase.value"
      :error="queryError"
      :writes-allowed="auth.writesAllowed"
      :refresh="refresh"
      :save="save"
      :remove="remove"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowDown, Rank } from '@element-plus/icons-vue';
import {
  V2_QUICK_ACTION_LIMITS,
  type V2QuickActionInput,
  type V2QuickActionItem
} from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import V2QuickActionsDrawer from './V2QuickActionsDrawer.vue';
import { useV2QuickActions } from './useV2QuickActions';
import { useV2QuickActionSorting } from './useV2QuickActionSorting';

const props = defineProps<{ active: boolean }>();
const auth = useAuthStore();
const drawer = ref<InstanceType<typeof V2QuickActionsDrawer>>();
const drawerOpen = ref(false);
const queryActive = ref(false);
const { keyword, sort, page } = useV2SessionDraft('quick-actions-sidebar-list', () => ({
  keyword: ref(''),
  sort: ref<'custom' | 'updated' | 'title'>('custom'),
  page: ref(1)
}));
const sortOptions = [
  { value: 'custom', label: '自定义排序' },
  { value: 'updated', label: '最近修改' },
  { value: 'title', label: '标题排序' }
] as const;
const sortLabel = computed(() => sortOptions.find((option) => option.value === sort.value)?.label);
const pageSize = 8;

watch(
  () => auth.user?.id ?? '',
  () => {
    drawerOpen.value = false;
  },
  { immediate: true }
);
const { query, items, migrationError, reorder, refresh } = useV2QuickActions({
  userId: () => auth.user?.id ?? '',
  writesAllowed: () => auth.writesAllowed,
  open: queryActive
});
watch(
  [() => props.active, drawerOpen, () => auth.user?.id ?? ''],
  ([active, open]) => {
    queryActive.value = active || open;
  },
  { immediate: true }
);
const queryError = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));
const mutationPending = computed(() => ordering.value || Boolean(drawer.value?.mutationPending));
const canReorder = computed(
  () =>
    props.active &&
    auth.writesAllowed &&
    query.phase.value === 'ready' &&
    !mutationPending.value &&
    !drawerOpen.value &&
    sort.value === 'custom' &&
    !keyword.value.trim()
);
const {
  ordering,
  customItems,
  cardsScroll,
  rowClass,
  startDrag,
  moveDrag,
  finishDrag,
  cancelDrag,
  moveWithKeyboard
} = useV2QuickActionSorting({
  items: () => items.value,
  enabled: () => canReorder.value,
  reorder
});
const limitReached = computed(() => items.value.length >= V2_QUICK_ACTION_LIMITS.count);
const filteredItems = computed(() => {
  const search = keyword.value.trim().toLocaleLowerCase();
  const rows = customItems.value.filter(
    (item) =>
      !search ||
      item.title.toLocaleLowerCase().includes(search) ||
      item.content.toLocaleLowerCase().includes(search)
  );
  if (sort.value === 'custom') return rows;
  return rows.sort((left, right) =>
    sort.value === 'title'
      ? left.title.localeCompare(right.title, 'zh-CN')
      : right.updatedAt.localeCompare(left.updatedAt)
  );
});
const pageItems = computed(() =>
  sort.value === 'custom'
    ? filteredItems.value
    : filteredItems.value.slice((page.value - 1) * pageSize, page.value * pageSize)
);
watch([keyword, sort], () => {
  cancelDrag();
  page.value = 1;
});
watch(
  () => props.active,
  (active) => {
    if (!active) cancelDrag();
  }
);
watch(
  () => filteredItems.value.length,
  (count) => {
    page.value = Math.max(1, Math.min(page.value, Math.ceil(count / pageSize)));
  }
);
function startCardDrag(event: PointerEvent, id: string) {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest('button:not([data-sort-id]), a, input, textarea, select, [role="menuitem"]')
  )
    return;
  startDrag(event, id);
}
function changeSort(value: string | number | object) {
  if (value === 'custom' || value === 'updated' || value === 'title') sort.value = value;
}
function handleItemCommand(command: string | number | object, item: V2QuickActionItem) {
  if (mutationPending.value) return;
  if (command === 'read') void drawer.value?.openReader(item);
  else if (command === 'edit') drawer.value?.startEdit(item);
  else if (command === 'delete') void drawer.value?.deleteItem(item);
}
async function save(input: V2QuickActionInput, id?: string) {
  try {
    if (id) await idBusinessV2WorkspaceApi.updateQuickAction(id, input);
    else await idBusinessV2WorkspaceApi.createQuickAction(input);
  } catch (error) {
    throw new Error(getApiErrorMessage(error), { cause: error });
  }
  await query.refresh();
}
async function remove(id: string) {
  try {
    await idBusinessV2WorkspaceApi.removeQuickAction(id);
  } catch (error) {
    throw new Error(getApiErrorMessage(error), { cause: error });
  }
  await query.refresh();
}
</script>

<style scoped>
.v2-quick-actions-panel {
  display: flex;
  flex-direction: column;
  gap: var(--v2-layout-control-gap);
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 12px;
}
.v2-quick-actions-panel__toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
}
.v2-quick-actions-panel__toolbar > .el-input {
  min-width: 0;
}
.v2-quick-actions-panel__toolbar .el-icon {
  margin-left: 4px;
}
.v2-quick-actions-panel__notice {
  margin: 0;
}
.v2-quick-actions-panel > :deep(.v2-async-region) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.v2-quick-actions-panel :deep(.v2-async-region__content) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.v2-quick-actions-panel__list {
  display: flex;
  flex-direction: column;
  align-content: start;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.v2-quick-actions-panel__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  flex-shrink: 0;
  min-width: 0;
  gap: 4px;
  padding: 8px;
}
.v2-quick-actions-panel__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.v2-quick-actions-panel__drag-title {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 0;
  touch-action: none;
  user-select: none;
}
.v2-quick-actions-panel__drag-title > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.v2-quick-actions-panel__drag-title > .el-icon {
  flex-shrink: 0;
}
.v2-quick-actions-panel__item.is-draggable {
  touch-action: none;
  user-select: none;
}
.v2-quick-actions-panel__item :deep(.el-button + .el-button) {
  margin-left: 0;
}
.v2-quick-actions-panel :deep(.el-pagination) {
  justify-content: center;
  flex-shrink: 0;
  padding-top: var(--v2-layout-control-gap);
}
.v2-quick-actions-panel :deep(.el-pager) {
  display: flex;
  min-width: 0;
  flex: 1 1 0;
  flex-wrap: wrap;
  justify-content: center;
}
@media (max-width: 900px) {
  .v2-quick-actions-panel__drag-title {
    min-height: 44px;
  }
}
</style>
