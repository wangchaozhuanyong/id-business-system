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
    @closed="resetEditor"
  >
    <div class="v2-quick-actions-drawer__body">
      <p class="v2-quick-actions-drawer__intro">保存常用回复，复制时只复制“内容”中的文字。</p>

      <div class="v2-quick-actions-drawer__toolbar">
        <el-input
          v-model="keyword"
          clearable
          maxlength="100"
          placeholder="搜索标题或内容"
          aria-label="搜索便捷操作"
        />
        <el-select v-model="sort" aria-label="便捷操作排序">
          <el-option label="最近修改" value="updated" />
          <el-option label="标题排序" value="title" />
        </el-select>
        <AppButton
          variant="primary"
          :disabled="!writesAllowed || saving || limitReached"
          @click="startCreate"
        >
          新增
        </AppButton>
      </div>

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
          <AppButton variant="ghost" :disabled="saving" @click="cancelEditor">取消</AppButton>
          <AppButton variant="primary" :loading="saving" @click="submitEditor">
            {{ editorMode === 'create' ? '添加' : '保存修改' }}
          </AppButton>
        </footer>
      </section>

      <V2AsyncRegion
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
        <p v-if="items.length && !filteredItems.length" class="v2-quick-actions-drawer__notice">
          没有匹配的便捷操作，请调整搜索词。
        </p>
        <template v-else>
          <div class="v2-quick-actions-drawer__table-scroll">
            <div class="v2-quick-actions-drawer__table-inner">
              <V2Table
                :data="pageItems"
                :schema="v2TableSchemas.workspace.quickActions"
                :show-column-settings="false"
              >
                <V2TableColumn :definition="v2TableSchemas.workspace.quickActions.columns[0]">
                  <template #default="{ row }">
                    <span class="v2-quick-actions-drawer__preview" :title="row.title">{{
                      row.title
                    }}</span>
                  </template>
                </V2TableColumn>
                <V2TableColumn :definition="v2TableSchemas.workspace.quickActions.columns[1]">
                  <template #default="{ row }">
                    <span class="v2-quick-actions-drawer__preview" :title="row.content">{{
                      row.content
                    }}</span>
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
                      :disabled="!writesAllowed || saving"
                      @click="startEdit(row)"
                      >修改</AppButton
                    >
                    <AppButton
                      size="small"
                      variant="ghost"
                      :disabled="!writesAllowed || saving"
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
            class="v2-records-mobile-list v2-quick-actions-drawer__cards"
            :data-mobile-for="v2TableSchemas.workspace.quickActions.id"
          >
            <article v-for="item in pageItems" :key="item.id" class="v2-quick-actions-drawer__card">
              <strong
                v-v2-column-visibility="[v2TableSchemas.workspace.quickActions.id, 'title']"
                >{{ item.title }}</strong
              >
              <p
                :ref="registerContentPreview"
                v-v2-column-visibility="[v2TableSchemas.workspace.quickActions.id, 'content']"
                :data-quick-action-id="item.id"
                :class="{ 'is-expanded': expandedIds.has(item.id) }"
              >
                {{ item.content }}
              </p>
              <button
                v-if="overflowingIds.has(item.id) || expandedIds.has(item.id)"
                class="v2-quick-actions-drawer__expand"
                type="button"
                :aria-expanded="expandedIds.has(item.id)"
                @click="toggleExpanded(item.id)"
              >
                {{ expandedIds.has(item.id) ? '收起全文' : '展开全文' }}
              </button>
              <footer>
                <AppButton size="small" variant="primary" @click="copyContent(item)"
                  >复制</AppButton
                >
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="!writesAllowed || saving"
                  @click="startEdit(item)"
                  >修改</AppButton
                >
                <AppButton
                  size="small"
                  variant="ghost"
                  :disabled="!writesAllowed || saving"
                  :loading="deletingId === item.id"
                  @click="deleteItem(item)"
                  >删除</AppButton
                >
              </footer>
            </article>
          </div>
          <el-pagination
            v-if="filteredItems.length > pageSize"
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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

const props = defineProps<{
  modelValue: boolean;
  items: V2QuickActionItem[];
  phase: V2QueryPhase;
  error: string;
  writesAllowed: boolean;
  refresh: () => Promise<unknown>;
  save: (input: V2QuickActionInput, id?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const formRef = ref<FormInstance>();
const form = reactive<V2QuickActionInput>({ title: '', content: '' });
const rules: FormRules<V2QuickActionInput> = {
  title: [{ required: true, whitespace: true, message: '请输入标题', trigger: 'blur' }],
  content: [{ required: true, whitespace: true, message: '请输入内容', trigger: 'blur' }]
};
const editorMode = ref<'create' | 'edit' | null>(null);
const editingId = ref('');
const editorSnapshot = ref('');
const mutationError = ref('');
const saving = ref(false);
const deletingId = ref('');
const mutationPending = computed(() => saving.value || Boolean(deletingId.value));
const keyword = ref('');
const sort = ref<'updated' | 'title'>('updated');
const page = ref(1);
const expandedIds = ref(new Set<string>());
const overflowingIds = ref(new Set<string>());
const contentPreviews = new Map<string, HTMLElement>();
const previewIds = new WeakMap<HTMLElement, string>();
let measurePending = false;
const pageSize = 8;
const limitReached = computed(() => props.items.length >= V2_QUICK_ACTION_LIMITS.count);

const dirty = computed(
  () => Boolean(editorMode.value) && JSON.stringify(form) !== editorSnapshot.value
);
const filteredItems = computed(() => {
  const search = keyword.value.trim().toLocaleLowerCase();
  const rows = props.items.filter(
    (item) =>
      !search ||
      item.title.toLocaleLowerCase().includes(search) ||
      item.content.toLocaleLowerCase().includes(search)
  );
  return rows.sort((left, right) =>
    sort.value === 'title'
      ? left.title.localeCompare(right.title, 'zh-CN')
      : right.updatedAt.localeCompare(left.updatedAt)
  );
});
const pageItems = computed(() =>
  filteredItems.value.slice((page.value - 1) * pageSize, page.value * pageSize)
);

watch([keyword, sort], () => (page.value = 1));
watch(
  () => filteredItems.value.length,
  (count) => {
    page.value = Math.max(1, Math.min(page.value, Math.ceil(count / pageSize)));
  }
);
watch(pageItems, scheduleOverflowMeasure, { flush: 'post' });
onMounted(() => window.addEventListener('resize', scheduleOverflowMeasure));
onBeforeUnmount(() => window.removeEventListener('resize', scheduleOverflowMeasure));

function registerContentPreview(element: unknown) {
  if (!(element instanceof HTMLElement)) return;
  const id = element.dataset.quickActionId;
  if (!id) return;
  const previousId = previewIds.get(element);
  if (previousId && previousId !== id) contentPreviews.delete(previousId);
  previewIds.set(element, id);
  if (contentPreviews.get(id) === element) return;
  contentPreviews.set(id, element);
  scheduleOverflowMeasure();
}

function scheduleOverflowMeasure() {
  if (measurePending) return;
  measurePending = true;
  void nextTick(() => {
    measurePending = false;
    const next = new Set<string>();
    for (const [id, element] of contentPreviews) {
      if (!element.isConnected) {
        contentPreviews.delete(id);
        continue;
      }
      if (expandedIds.value.has(id)) {
        if (overflowingIds.value.has(id)) next.add(id);
      } else if (
        element.getBoundingClientRect().width &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        next.add(id);
      }
    }
    if (
      next.size !== overflowingIds.value.size ||
      [...next].some((id) => !overflowingIds.value.has(id))
    ) {
      overflowingIds.value = next;
    }
  });
}

function toggleExpanded(id: string) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
  scheduleOverflowMeasure();
}

function setEditor(mode: 'create' | 'edit', item?: V2QuickActionItem) {
  editorMode.value = mode;
  editingId.value = item?.id ?? '';
  form.title = item?.title ?? '';
  form.content = item?.content ?? '';
  editorSnapshot.value = JSON.stringify(form);
  mutationError.value = '';
  formRef.value?.clearValidate();
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前内容尚未保存，确认放弃修改吗？', '放弃修改', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续编辑',
      type: 'warning'
    });
    return true;
  } catch {
    return false;
  }
}

async function startCreate() {
  if (saving.value || !(await confirmDiscard())) return;
  setEditor('create');
}

async function startEdit(item: V2QuickActionItem) {
  if (saving.value || !(await confirmDiscard())) return;
  setEditor('edit', item);
}

async function cancelEditor() {
  if (await confirmDiscard()) resetEditor();
}

function resetEditor() {
  editorMode.value = null;
  editingId.value = '';
  form.title = '';
  form.content = '';
  editorSnapshot.value = '';
  mutationError.value = '';
}

async function submitEditor() {
  if (!editorMode.value || saving.value || !props.writesAllowed) return;
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  mutationError.value = '';
  try {
    await props.save(
      { title: form.title.trim(), content: form.content },
      editorMode.value === 'edit' ? editingId.value : undefined
    );
    ElMessage.success(editorMode.value === 'create' ? '已添加便捷操作' : '已保存修改');
    resetEditor();
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

async function deleteItem(item: V2QuickActionItem) {
  if (!props.writesAllowed || deletingId.value || saving.value) return;
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

async function handleBeforeClose(done: () => void) {
  if (mutationPending.value) return;
  if (await confirmDiscard()) done();
}
</script>

<style scoped>
:global(.v2-quick-actions-drawer .el-drawer__header) {
  margin-bottom: 0;
}

.v2-quick-actions-drawer__body {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.v2-quick-actions-drawer__intro,
.v2-quick-actions-drawer__notice {
  margin: 0;
  color: var(--v3-text-soft);
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
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-quick-actions-drawer__table-scroll {
  min-width: 0;
  overflow-x: auto;
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
  margin-top: 12px;
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

  .v2-quick-actions-drawer__card p.is-expanded {
    display: block;
    overflow: visible;
  }

  .v2-quick-actions-drawer__card footer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>
