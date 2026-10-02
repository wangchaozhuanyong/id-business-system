<template>
  <el-drawer
    id="v2-quick-actions-drawer"
    class="v2-quick-actions-drawer"
    :model-value="modelValue"
    title="便捷操作"
    size="min(720px, 100vw)"
    append-to-body
    :close-on-click-modal="!mutationPending"
    :close-on-press-escape="!mutationPending"
    :show-close="!mutationPending"
    :before-close="handleBeforeClose"
    @close="emit('update:modelValue', false)"
  >
    <div
      class="v2-quick-actions-drawer__body"
      @pointermove="moveDrag"
      @pointerup="finishDrag"
      @pointercancel="cancelDrag"
      @lostpointercapture="cancelDrag"
    >
      <div v-if="!selectedReply && !editorMode" class="v2-quick-actions-drawer__intro">
        <p>常用回复随手可用，点击摘要查看全文。</p>
        <span>{{ items.length }} 条回复</span>
      </div>

      <div v-if="!selectedReply && !editorMode" class="v2-quick-actions-drawer__toolbar">
        <el-input
          v-model="keyword"
          :disabled="mutationPending"
          clearable
          maxlength="100"
          placeholder="搜索标题或内容"
          aria-label="搜索便捷操作"
        />
        <el-select v-model="sort" aria-label="便捷操作排序" :disabled="mutationPending">
          <el-option label="自定义排序" value="custom" />
          <el-option label="最近修改" value="updated" />
          <el-option label="标题排序" value="title" />
        </el-select>
        <AppButton
          variant="primary"
          :disabled="!writesAllowed || mutationPending || limitReached"
          @click="startCreate"
        >
          新增
        </AppButton>
      </div>

      <p
        v-if="!selectedReply && !editorMode && sort === 'custom' && items.length > 1"
        class="v2-quick-actions-drawer__notice"
        role="status"
      >
        {{
          ordering
            ? '正在保存顺序…'
            : keyword.trim()
              ? '清空搜索后可拖拽排序。'
              : '拖动左侧手柄调整顺序，自动保存在当前浏览器；也可选中手柄，用上下方向键调整。'
        }}
      </p>

      <p v-if="!writesAllowed" class="v2-quick-actions-drawer__notice" role="status">
        当前连接处于只读状态，恢复后才能修改便捷操作。
      </p>
      <p v-else-if="limitReached" class="v2-quick-actions-drawer__notice" role="status">
        已达到每人 {{ V2_QUICK_ACTION_LIMITS.count }} 条的上限，可删除不用的内容后再添加。
      </p>

      <section v-if="editorMode" class="v2-quick-actions-editor" aria-label="便捷操作表单">
        <header>
          <strong>{{ editorMode === 'create' ? '新增便捷操作' : '修改便捷操作' }}</strong>
          <span>标题仅用于查找，复制时不会带上标题。</span>
        </header>
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="left"
          label-width="64px"
          require-asterisk-position="right"
          scroll-to-error
          @submit.prevent="submitEditor"
        >
          <el-form-item label="标题" prop="title">
            <el-input
              v-model="form.title"
              :maxlength="V2_QUICK_ACTION_LIMITS.title"
              show-word-limit
              placeholder="例如：报价前确认资料"
            />
          </el-form-item>
          <el-form-item label="内容" prop="content">
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="6"
              :maxlength="V2_QUICK_ACTION_LIMITS.content"
              show-word-limit
              placeholder="输入要发给客户的文字"
            />
          </el-form-item>
        </el-form>
        <p v-if="mutationError" class="v2-quick-actions-editor__error" role="alert">
          {{ mutationError }}
        </p>
        <footer>
          <AppButton variant="ghost" :disabled="saving" @click="cancelEditor">返回列表</AppButton>
          <AppButton variant="primary" :loading="saving" @click="submitEditor">
            {{ editorMode === 'create' ? '添加' : '保存修改' }}
          </AppButton>
        </footer>
      </section>

      <V2AsyncRegion
        v-if="!editorMode"
        :phase="phase"
        :empty="items.length === 0"
        :error="error"
        variant="section"
        skeleton="inline"
        loading-title="正在读取便捷操作"
        refreshing-title="正在更新便捷操作"
        empty-title="还没有便捷操作"
        empty-message="新增标题和内容后，即可一键复制给客户。"
        error-title="便捷操作加载失败"
        @retry="refresh"
      >
        <template #empty-action>
          <AppButton v-if="writesAllowed" variant="primary" size="small" @click="startCreate">
            新增第一条
          </AppButton>
        </template>
        <section v-if="selectedReply" class="v2-quick-actions-reader" aria-label="回复全文">
          <header>
            <AppButton variant="ghost" size="small" @click="closeReader">返回回复列表</AppButton>
            <span>{{ selectedReply.content.length }} 字 · 仅复制正文</span>
          </header>
          <div class="v2-quick-actions-reader__paper" tabindex="0" aria-label="回复正文">
            <h3 ref="readerHeading" tabindex="-1">{{ selectedReply.title }}</h3>
            <p>{{ selectedReply.content }}</p>
          </div>
          <footer>
            <AppButton
              variant="ghost"
              :disabled="!writesAllowed || mutationPending"
              @click="startEdit(selectedReply)"
              >修改</AppButton
            >
            <AppButton
              variant="ghost"
              :disabled="!writesAllowed || ordering || saving"
              :loading="deletingId === selectedReply.id"
              @click="deleteItem(selectedReply)"
              >删除</AppButton
            >
            <AppButton variant="primary" @click="copyContent(selectedReply)">复制全文</AppButton>
          </footer>
        </section>
        <p
          v-else-if="items.length && !filteredItems.length"
          class="v2-quick-actions-drawer__notice"
        >
          没有匹配的便捷操作，请调整搜索词。
        </p>
        <template v-else>
          <div ref="tableScroll" class="v2-quick-actions-drawer__table-scroll">
            <div class="v2-quick-actions-drawer__table-inner">
              <V2Table
                :data="pageItems"
                :schema="v2TableSchemas.workspace.quickActions"
                :show-column-settings="false"
                :row-class-name="rowClass"
              >
                <V2TableColumn
                  :definition="v2TableSchemas.workspace.quickActions.columns[0]"
                  :show-overflow-tooltip="false"
                >
                  <template #default="{ row }">
                    <div class="v2-quick-actions-drawer__sortable-title">
                      <button
                        v-if="sort === 'custom'"
                        class="v2-quick-actions-drawer__sort-handle"
                        type="button"
                        :disabled="!canReorder"
                        :aria-label="`调整顺序：${row.title}`"
                        :data-sort-id="row.id"
                        @pointerdown="startDrag($event, row.id)"
                        @keydown="moveWithKeyboard($event, row.id)"
                      >
                        <el-icon aria-hidden="true"><Rank /></el-icon>
                      </button>
                      <span class="v2-quick-actions-drawer__title">{{ row.title }}</span>
                    </div>
                  </template>
                </V2TableColumn>
                <V2TableColumn
                  :definition="v2TableSchemas.workspace.quickActions.columns[1]"
                  :show-overflow-tooltip="false"
                >
                  <template #default="{ row }">
                    <button
                      :ref="readerFocusRef(row)"
                      class="v2-quick-actions-drawer__preview"
                      type="button"
                      :aria-label="`查看全文：${row.title}`"
                      :data-reply-id="row.id"
                      @click="openReader(row)"
                    >
                      <span>{{ row.content }}</span>
                      <small>查看全文</small>
                    </button>
                  </template>
                </V2TableColumn>
                <V2TableActionColumn :definition="v2TableSchemas.workspace.quickActions.columns[2]">
                  <template #default="{ row }">
                    <AppButton size="small" variant="primary" @click="copyContent(row)"
                      >复制</AppButton
                    >
                    <AppButton
                      size="small"
                      variant="ghost"
                      :disabled="!writesAllowed || mutationPending"
                      @click="startEdit(row)"
                      >修改</AppButton
                    >
                    <AppButton
                      size="small"
                      variant="ghost"
                      :disabled="!writesAllowed || ordering || saving"
                      :loading="deletingId === row.id"
                      @click="deleteItem(row)"
                      >删除</AppButton
                    >
                  </template>
                </V2TableActionColumn>
              </V2Table>
            </div>
          </div>
          <div
            ref="cardsScroll"
            class="v2-records-mobile-list v2-quick-actions-drawer__cards"
            :data-mobile-for="v2TableSchemas.workspace.quickActions.id"
          >
            <article
              v-for="item in pageItems"
              :key="item.id"
              class="v2-quick-actions-drawer__card"
              :class="rowClass({ row: item })"
            >
              <div class="v2-quick-actions-drawer__sortable-title">
                <button
                  v-if="sort === 'custom'"
                  class="v2-quick-actions-drawer__sort-handle"
                  type="button"
                  :disabled="!canReorder"
                  :aria-label="`调整顺序：${item.title}`"
                  :data-sort-id="item.id"
                  @pointerdown="startDrag($event, item.id)"
                  @keydown="moveWithKeyboard($event, item.id)"
                >
                  <el-icon aria-hidden="true"><Rank /></el-icon>
                </button>
                <strong
                  v-v2-column-visibility="[v2TableSchemas.workspace.quickActions.id, 'title']"
                  >{{ item.title }}</strong
                >
              </div>
              <p v-v2-column-visibility="[v2TableSchemas.workspace.quickActions.id, 'content']">
                {{ item.content }}
              </p>
              <button
                :ref="readerFocusRef(item)"
                class="v2-quick-actions-drawer__expand"
                type="button"
                :aria-label="`查看全文：${item.title}`"
                :data-reply-id="item.id"
                @click="openReader(item)"
              >
                查看全文
              </button>
              <footer>
                <AppButton size="small" variant="primary" @click="copyContent(item)"
                  >复制</AppButton
                >
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="!writesAllowed || mutationPending"
                  @click="startEdit(item)"
                  >修改</AppButton
                >
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="!writesAllowed || ordering || saving"
                  :loading="deletingId === item.id"
                  @click="deleteItem(item)"
                  >删除</AppButton
                >
              </footer>
            </article>
          </div>
          <el-pagination
            v-if="sort !== 'custom' && filteredItems.length > pageSize"
            v-model:current-page="page"
            :page-size="pageSize"
            :total="filteredItems.length"
            layout="prev, pager, next"
            size="small"
            aria-label="便捷操作分页"
          />
        </template>
      </V2AsyncRegion>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, nextTick, ref, watch } from 'vue';
import { Rank } from '@element-plus/icons-vue';
import type { FormInstance, FormRules } from 'element-plus';
import {
  V2_QUICK_ACTION_LIMITS,
  type V2QuickActionInput,
  type V2QuickActionItem
} from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2DrawerNavigation } from '@/v2/composables/useV2DrawerNavigation';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2QuickActionSorting } from './useV2QuickActionSorting';

const props = defineProps<{
  modelValue: boolean;
  items: V2QuickActionItem[];
  phase: V2QueryPhase;
  error: string;
  writesAllowed: boolean;
  refresh: () => Promise<unknown>;
  save: (input: V2QuickActionInput, id?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
useV2DrawerNavigation(() => emit('update:modelValue', false));
const formRef = ref<FormInstance>();
const {
  form,
  open: openDraft,
  beginSave: beginDraftSave
} = useV2FormDraft<V2QuickActionInput>('quick-actions-editor', () => ({ title: '', content: '' }));
const rules: FormRules<V2QuickActionInput> = {
  title: [{ required: true, whitespace: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, whitespace: true, message: '请输入内容', trigger: 'blur' }]
};
const { editorMode, editingId, mutationError, keyword, sort, page, selectedId } = useV2SessionDraft(
  'quick-actions-view',
  () => ({
    editorMode: ref<'create' | 'edit' | null>(null),
    editingId: ref(''),
    mutationError: ref(''),
    keyword: ref(''),
    sort: ref<'custom' | 'updated' | 'title'>('custom'),
    page: ref(1),
    selectedId: ref('')
  })
);
if (editorMode.value) openDraft(editingId.value || 'create');
const saving = ref(false);
const deletingId = ref('');
const mutationPending = computed(() => saving.value || ordering.value || Boolean(deletingId.value));
const canReorder = computed(
  () =>
    props.writesAllowed &&
    !mutationPending.value &&
    sort.value === 'custom' &&
    !keyword.value.trim()
);
const {
  ordering,
  customItems,
  tableScroll,
  cardsScroll,
  rowClass,
  startDrag,
  moveDrag,
  finishDrag,
  cancelDrag,
  moveWithKeyboard
} = useV2QuickActionSorting({
  items: () => props.items,
  enabled: () => canReorder.value,
  reorder: (ids) => props.reorder(ids)
});
const selectedReply = computed(() => props.items.find((item) => item.id === selectedId.value));
const readerHeading = ref<HTMLElement>();
let returnFocusId = '';
const pageSize = 8;
const limitReached = computed(() => props.items.length >= V2_QUICK_ACTION_LIMITS.count);

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
  () => props.modelValue,
  (open) => {
    if (!open) cancelDrag();
  }
);
watch(
  () => filteredItems.value.length,
  (count) => {
    page.value = Math.max(1, Math.min(page.value, Math.ceil(count / pageSize)));
  }
);
async function openReader(item: V2QuickActionItem) {
  selectedId.value = item.id;
  await nextTick();
  readerHeading.value?.focus({ preventScroll: true });
}

function closeReader() {
  returnFocusId = selectedId.value;
  selectedId.value = '';
}

function restoreReaderFocus(element: unknown, id: string) {
  if (!(element instanceof HTMLElement) || returnFocusId !== id) return;
  void nextTick(() => {
    if (returnFocusId === id && element.isConnected && element.getClientRects().length) {
      element.focus({ preventScroll: true });
      returnFocusId = '';
    }
  });
}

function readerFocusRef(item: V2QuickActionItem) {
  return (element: unknown) => restoreReaderFocus(element, item.id);
}

function setEditor(mode: 'create' | 'edit', item?: V2QuickActionItem) {
  editorMode.value = mode;
  editingId.value = item?.id ?? '';
  openDraft(item?.id ?? 'create', { title: item?.title ?? '', content: item?.content ?? '' });
  mutationError.value = '';
  formRef.value?.clearValidate();
}

function startCreate() {
  if (mutationPending.value) return;
  setEditor('create');
}

function startEdit(item: V2QuickActionItem) {
  if (mutationPending.value) return;
  setEditor('edit', item);
}

function cancelEditor() {
  editorMode.value = null;
  editingId.value = '';
}

function resetEditor(completeDraft = beginDraftSave()) {
  if (!completeDraft()) return;
  editorMode.value = null;
  editingId.value = '';
  form.title = '';
  form.content = '';
  mutationError.value = '';
}

async function submitEditor() {
  if (!editorMode.value || saving.value || !props.writesAllowed) return;
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  const completeDraft = beginDraftSave();
  mutationError.value = '';
  try {
    await props.save(
      { title: form.title.trim(), content: form.content },
      editorMode.value === 'edit' ? editingId.value : undefined
    );
    ElMessage.success(editorMode.value === 'create' ? '已添加便捷操作' : '已保存修改');
    resetEditor(completeDraft);
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

async function deleteItem(item: V2QuickActionItem) {
  if (!props.writesAllowed || mutationPending.value) return;
  try {
    await ElMessageBox.confirm(`确认删除“${item.title}”吗？`, '删除便捷操作', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    });
  } catch {
    return;
  }
  deletingId.value = item.id;
  try {
    await props.remove(item.id);
    if (editingId.value === item.id) resetEditor();
    if (selectedId.value === item.id) selectedId.value = '';
    ElMessage.success('已删除便捷操作');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败，请重试');
  } finally {
    deletingId.value = '';
  }
}

async function copyContent(item: V2QuickActionItem) {
  try {
    await navigator.clipboard.writeText(item.content);
    ElMessage.success('内容已复制');
  } catch {
    ElMessage.error('复制失败，请检查浏览器剪贴板权限');
  }
}

function handleBeforeClose(done: () => void) {
  if (mutationPending.value) return;
  done();
}
</script>

<style scoped>
:global(.v2-quick-actions-drawer .el-drawer__header) {
  margin-bottom: 0;
}

.v2-quick-actions-drawer__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  height: 100%;
}

.v2-quick-actions-drawer__intro,
.v2-quick-actions-drawer__notice {
  margin: 0;
  color: var(--v3-text-soft);
}

.v2-quick-actions-drawer__intro {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
}

.v2-quick-actions-drawer__intro p {
  margin: 0;
}

.v2-quick-actions-drawer__notice {
  font-size: 12px;
  line-height: 1.6;
}

.v2-quick-actions-drawer__sortable-title {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.v2-quick-actions-drawer__sortable-title > span,
.v2-quick-actions-drawer__sortable-title > strong {
  min-width: 0;
}

.v2-quick-actions-drawer__sort-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: var(--v3-radius-sm);
  background: transparent;
  color: var(--v3-text-soft);
  font-size: 18px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.v2-quick-actions-drawer__sort-handle:active {
  cursor: grabbing;
}

.v2-quick-actions-drawer__sort-handle:disabled {
  cursor: not-allowed;
}

.v2-quick-actions-drawer__sort-handle:focus-visible {
  outline: 2px solid var(--v3-focus-color);
  outline-offset: -2px;
}

.v2-quick-actions-drawer__body :deep(.is-sorting td),
.v2-quick-actions-drawer__card.is-sorting {
  background: var(--v3-surface-2);
}

.v2-quick-actions-drawer__body :deep(.sort-before td),
.v2-quick-actions-drawer__card.sort-before {
  box-shadow: inset 0 2px var(--v3-primary);
}

.v2-quick-actions-drawer__body :deep(.sort-after td),
.v2-quick-actions-drawer__card.sort-after {
  box-shadow: inset 0 -2px var(--v3-primary);
}

@media (max-width: 900px) {
  .v2-quick-actions-drawer__sort-handle {
    width: 44px;
    height: 44px;
  }
}
.v2-quick-actions-drawer__intro span {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.v2-quick-actions-drawer__body > :deep(.v2-async-region) {
  flex: 1;
  min-height: 0;
}

.v2-quick-actions-drawer__body :deep(.v2-async-region__content) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.v2-quick-actions-drawer__toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 128px auto;
  gap: 8px;
}

.v2-quick-actions-editor {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius-lg);
  background: var(--v3-surface-2);
}

.v2-quick-actions-editor header {
  display: grid;
  gap: 4px;
}

.v2-quick-actions-editor header strong {
  font-size: 15px;
}

.v2-quick-actions-editor header span,
.v2-quick-actions-editor__error {
  color: var(--v3-text-soft);
}

.v2-quick-actions-editor__error {
  margin: 0;
  color: var(--v3-danger);
}

.v2-quick-actions-editor footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-quick-actions-drawer__preview {
  display: grid;
  gap: 4px;
  width: 100%;
  min-height: 66px;
  padding: 6px 0;
  border: 0;
  border-radius: var(--v3-radius-sm);
  background: transparent;
  color: var(--v3-text-soft);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.v2-quick-actions-drawer__preview span,
.v2-quick-actions-drawer__title {
  display: -webkit-box;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.6;
}

.v2-quick-actions-drawer__title {
  font-weight: 600;
  color: var(--v3-text);
}
.v2-quick-actions-drawer__preview small {
  color: var(--v3-primary);
  font-size: 12px;
}
.v2-quick-actions-drawer__preview:hover small {
  text-decoration: underline;
}
.v2-quick-actions-drawer__preview:focus-visible {
  outline: 2px solid var(--v3-focus-color);
  outline-offset: 2px;
}

.v2-quick-actions-drawer__table-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius);
}

.v2-quick-actions-drawer__table-inner {
  min-width: 620px;
}

.v2-quick-actions-drawer__cards {
  display: none;
}

.v2-quick-actions-drawer__expand {
  justify-self: start;
  min-height: 36px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--v3-radius-sm);
  background: transparent;
  color: var(--v3-primary);
  font: inherit;
  cursor: pointer;
}

.v2-quick-actions-drawer__expand:hover {
  text-decoration: underline;
}

.v2-quick-actions-drawer__expand:focus-visible {
  outline: 2px solid var(--v3-focus-color);
  outline-offset: 2px;
}

.v2-quick-actions-drawer__body :deep(.el-pagination) {
  justify-content: flex-end;
  flex-shrink: 0;
  padding-top: 16px;
}

.v2-quick-actions-reader {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 16px;
  flex: 1;
  min-height: 0;
}

.v2-quick-actions-reader header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-quick-actions-reader header span {
  color: var(--v3-text-soft);
  font-size: 12px;
}

.v2-quick-actions-reader__paper {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 24px;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius-lg);
  background: var(--v3-surface-2);
  overflow-wrap: anywhere;
}

.v2-quick-actions-reader__paper h3 {
  margin: 0 0 20px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--v3-border);
  color: var(--v3-text);
  font-size: 18px;
  line-height: 1.5;
}

.v2-quick-actions-reader__paper p {
  margin: 0;
  color: var(--v3-text);
  font-size: 14px;
  line-height: 1.9;
  white-space: pre-wrap;
}

.v2-quick-actions-reader footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--v3-border);
}

.v2-quick-actions-reader footer :deep(.el-button:last-child) {
  margin-left: auto;
}
.v2-quick-actions-reader footer :deep(.el-button + .el-button:not(:last-child)),
.v2-quick-actions-editor footer :deep(.el-button + .el-button) {
  margin-left: 0;
}
.v2-quick-actions-reader :deep(.el-button) {
  min-height: 36px;
}

@media (max-width: 600px) {
  .v2-quick-actions-reader__paper {
    padding: 18px;
  }
  .v2-quick-actions-reader :deep(.el-button) {
    min-height: 44px;
  }
}

@media (max-width: 600px) {
  .v2-quick-actions-drawer__toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .v2-quick-actions-drawer__toolbar .el-input {
    grid-column: 1 / -1;
  }

  .v2-quick-actions-drawer__toolbar :deep(.el-input__wrapper),
  .v2-quick-actions-drawer__toolbar :deep(.el-select__wrapper),
  .v2-quick-actions-drawer__toolbar :deep(.el-button),
  .v2-quick-actions-drawer__card footer :deep(.el-button),
  .v2-quick-actions-drawer__expand {
    min-height: 44px;
  }
}

@media (max-width: 900px) {
  .v2-quick-actions-drawer__table-scroll {
    display: none;
  }

  .v2-quick-actions-drawer__cards {
    display: grid;
    align-content: start;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    gap: 10px;
  }

  .v2-quick-actions-drawer__card {
    display: grid;
    min-width: 0;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--v3-border);
    border-radius: var(--v3-radius);
    background: var(--v3-surface);
  }

  .v2-quick-actions-drawer__card strong {
    overflow-wrap: anywhere;
  }

  .v2-quick-actions-drawer__card p {
    display: -webkit-box;
    overflow: hidden;
    margin: 0;
    color: var(--v3-text-soft);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  }

  .v2-quick-actions-drawer__card footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .v2-quick-actions-drawer__card footer :deep(.el-button + .el-button) {
    margin-left: 0;
  }
}
</style>
