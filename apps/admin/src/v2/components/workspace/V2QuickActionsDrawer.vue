<template>
  <el-drawer
    id="v2-quick-actions-drawer"
    class="v2-quick-actions-drawer"
    :model-value="modelValue"
    title="话术文案"
    size="min(720px, 100vw)"
    append-to-body
    :close-on-click-modal="!mutationPending"
    :close-on-press-escape="!mutationPending"
    :show-close="!mutationPending"
    :before-close="handleBeforeClose"
    @close="emit('update:modelValue', false)"
    @opened="focusReader"
  >
    <div class="v2-quick-actions-drawer__body">
      <p v-if="!writesAllowed" class="v2-quick-actions-drawer__notice" role="status">
        当前连接处于只读状态，恢复后才能修改话术文案。
      </p>
      <section v-if="editorMode" class="v2-quick-actions-editor" aria-label="话术文案表单">
        <header>
          <strong>{{ editorMode === 'create' ? '新增话术文案' : '编辑话术文案' }}</strong>
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
              :rows="8"
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
          <AppButton variant="ghost" :disabled="saving" @click="closeDrawer">返回列表</AppButton>
          <AppButton
            variant="primary"
            :disabled="!writesAllowed"
            :loading="saving"
            @click="submitEditor"
          >
            {{ editorMode === 'create' ? '添加' : '保存修改' }}
          </AppButton>
        </footer>
      </section>
      <V2AsyncRegion
        v-else
        :phase="phase"
        :empty="!selectedReply"
        :error="error"
        variant="section"
        skeleton="inline"
        loading-title="正在读取话术文案"
        refreshing-title="正在更新话术文案"
        empty-title="话术文案已不存在"
        empty-message="请返回列表选择其他文案。"
        error-title="话术文案加载失败"
        @retry="refresh"
      >
        <template #empty-action>
          <AppButton variant="ghost" @click="closeDrawer">返回列表</AppButton>
        </template>
        <section v-if="selectedReply" class="v2-quick-actions-reader" aria-label="话术全文">
          <header>
            <AppButton variant="ghost" size="small" @click="closeDrawer">返回列表</AppButton>
            <span>{{ selectedReply.content.length }} 字 · 仅复制正文</span>
          </header>
          <div class="v2-quick-actions-reader__paper" tabindex="0" aria-label="话术正文">
            <h3 ref="readerHeading" tabindex="-1">{{ selectedReply.title }}</h3>
            <p>{{ selectedReply.content }}</p>
          </div>
          <footer>
            <AppButton
              variant="ghost"
              :disabled="!writesAllowed || mutationPending"
              @click="startEdit(selectedReply)"
              >编辑文案</AppButton
            >
            <AppButton
              variant="ghost"
              :disabled="!writesAllowed || saving || Boolean(confirmingId)"
              :loading="deletingId === selectedReply.id"
              @click="deleteItem(selectedReply)"
              >删除文案</AppButton
            >
            <AppButton variant="primary" @click="copyContent(selectedReply)">复制文案</AppButton>
          </footer>
        </section>
      </V2AsyncRegion>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, nextTick, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import {
  V2_QUICK_ACTION_LIMITS,
  type V2QuickActionInput,
  type V2QuickActionItem
} from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2DrawerNavigation } from '@/v2/composables/useV2DrawerNavigation';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';

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
const { editorMode, editingId, mutationError, selectedId } = useV2SessionDraft(
  'quick-actions-view',
  () => ({
    editorMode: ref<'create' | 'edit' | null>(null),
    editingId: ref(''),
    mutationError: ref(''),
    selectedId: ref('')
  })
);
if (editorMode.value) openDraft(editingId.value || 'create');
const saving = ref(false);
const deletingId = ref('');
const confirmingId = ref('');
const mutationPending = computed(
  () => saving.value || Boolean(deletingId.value) || Boolean(confirmingId.value)
);
const selectedReply = computed(() => props.items.find((item) => item.id === selectedId.value));
const readerHeading = ref<HTMLElement>();

function focusReader() {
  if (!editorMode.value) readerHeading.value?.focus({ preventScroll: true });
}
async function openReader(item: V2QuickActionItem) {
  if (mutationPending.value) return;
  selectedId.value = item.id;
  editorMode.value = null;
  editingId.value = '';
  emit('update:modelValue', true);
  await nextTick();
  focusReader();
}
function closeDrawer() {
  if (!mutationPending.value) emit('update:modelValue', false);
}
function setEditor(mode: 'create' | 'edit', item?: V2QuickActionItem) {
  editorMode.value = mode;
  editingId.value = item?.id ?? '';
  openDraft(item?.id ?? 'create', { title: item?.title ?? '', content: item?.content ?? '' });
  mutationError.value = '';
  formRef.value?.clearValidate();
  emit('update:modelValue', true);
}
function startCreate() {
  if (
    mutationPending.value ||
    !props.writesAllowed ||
    props.items.length >= V2_QUICK_ACTION_LIMITS.count
  )
    return;
  setEditor('create');
}
function startEdit(item: V2QuickActionItem) {
  if (mutationPending.value || !props.writesAllowed) return;
  setEditor('edit', item);
}
function resetEditor(completeDraft = beginDraftSave()) {
  if (!completeDraft()) return false;
  editorMode.value = null;
  editingId.value = '';
  form.title = '';
  form.content = '';
  mutationError.value = '';
  return true;
}
async function submitEditor() {
  if (!editorMode.value || saving.value || !props.writesAllowed) return;
  if (!(await validateV2Form(formRef.value))) return;
  saving.value = true;
  const completeDraft = beginDraftSave();
  const mode = editorMode.value;
  mutationError.value = '';
  try {
    await props.save(
      { title: form.title.trim(), content: form.content },
      mode === 'edit' ? editingId.value : undefined
    );
    ElMessage.success(mode === 'create' ? '已添加话术文案' : '已保存修改');
    if (resetEditor(completeDraft)) emit('update:modelValue', false);
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}
async function deleteItem(item: V2QuickActionItem) {
  if (!props.writesAllowed || mutationPending.value) return;
  confirmingId.value = item.id;
  try {
    await ElMessageBox.confirm(`确认删除“${item.title}”吗？`, '删除话术文案', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    });
  } catch {
    return;
  } finally {
    confirmingId.value = '';
  }
  if (!props.writesAllowed) return;
  deletingId.value = item.id;
  try {
    await props.remove(item.id);
    if (editingId.value === item.id) resetEditor();
    if (selectedId.value === item.id) {
      selectedId.value = '';
      emit('update:modelValue', false);
    }
    ElMessage.success('已删除话术文案');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败，请重试');
  } finally {
    deletingId.value = '';
  }
}
async function copyContent(item: V2QuickActionItem) {
  try {
    await navigator.clipboard.writeText(item.content);
    ElMessage.success('文案已复制');
  } catch {
    ElMessage.error('复制失败，请检查浏览器剪贴板权限');
  }
}
function handleBeforeClose(done: () => void) {
  if (!mutationPending.value) done();
}
defineExpose({ startCreate, startEdit, openReader, deleteItem, copyContent, mutationPending });
</script>

<style scoped>
:global(.v2-quick-actions-drawer .el-drawer__header) {
  margin-bottom: 0;
}
.v2-quick-actions-drawer__body {
  display: flex;
  flex-direction: column;
  gap: var(--v2-layout-panel-gap);
  min-width: 0;
  height: 100%;
}
.v2-quick-actions-drawer__notice {
  margin: 0;
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
.v2-quick-actions-editor {
  display: grid;
  gap: var(--v2-layout-section-gap);
  padding: var(--v2-layout-panel-padding);
}
.v2-quick-actions-editor header {
  display: grid;
  gap: 4px;
}
.v2-quick-actions-editor__error {
  margin: 0;
}
.v2-quick-actions-editor footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.v2-quick-actions-reader {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: var(--v2-layout-panel-gap);
  flex: 1;
  min-height: 0;
}
.v2-quick-actions-reader header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.v2-quick-actions-reader__paper {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 24px;
  overflow-wrap: anywhere;
}
.v2-quick-actions-reader__paper h3 {
  margin: 0 0 20px;
  padding-bottom: 18px;
}
.v2-quick-actions-reader__paper p {
  margin: 0;
  white-space: pre-wrap;
}
.v2-quick-actions-reader footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: var(--v2-layout-panel-gap);
}
.v2-quick-actions-reader footer :deep(.el-button:last-child) {
  margin-left: auto;
}
.v2-quick-actions-reader footer :deep(.el-button + .el-button:not(:last-child)),
.v2-quick-actions-editor footer :deep(.el-button + .el-button) {
  margin-left: 0;
}
@media (max-width: 600px) {
  .v2-quick-actions-reader__paper {
    padding: 18px;
  }
}
</style>
