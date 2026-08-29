<template>
  <el-drawer
    class="v2-workspace-shortcut-drawer"
    :model-value="modelValue"
    title="快捷网址设置"
    size="min(620px, 100vw)"
    append-to-body
    destroy-on-close
    :close-on-click-modal="!mutationPending"
    :close-on-press-escape="!mutationPending"
    :show-close="!mutationPending"
    :before-close="handleBeforeClose"
    @close="$emit('update:modelValue', false)"
    @closed="resetEditor"
  >
    <div class="v2-workspace-shortcut-drawer__body">
      <div class="v2-workspace-shortcut-drawer__toolbar">
        <div>
          <strong>我的快捷网址</strong>
          <span>{{ items.length }} / {{ V2_WORKSPACE_SHORTCUT_LIMITS.count }}</span>
        </div>
        <AppButton
          class="v2-workspace-shortcut-drawer__add"
          variant="primary"
          size="small"
          :disabled="!writesAllowed || shortcutLimitReached"
          @click="startCreate"
        >
          <el-icon><Plus /></el-icon>
          新增网址
        </AppButton>
      </div>

      <p v-if="!writesAllowed" class="v2-workspace-shortcut-drawer__readonly" role="status">
        当前登录连接处于只读状态，恢复后才能修改快捷网址。
      </p>

      <section v-if="editorMode" class="v2-workspace-shortcut-editor" aria-label="快捷网址表单">
        <header>
          <strong>{{ editorMode === 'create' ? '新增快捷网址' : '修改快捷网址' }}</strong>
          <span>只允许 HTTP 或 HTTPS 地址</span>
        </header>
        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="left"
          label-width="88px"
          require-asterisk-position="right"
          class="v2-horizontal-form"
          @submit.prevent
        >
          <el-form-item label="网址名称" prop="name">
            <el-input
              v-model="form.name"
              :maxlength="V2_WORKSPACE_SHORTCUT_LIMITS.name"
              show-word-limit
              autocomplete="off"
              placeholder="例如：工作邮箱"
            />
          </el-form-item>
          <el-form-item label="网址" prop="url">
            <el-input
              v-model="form.url"
              :maxlength="V2_WORKSPACE_SHORTCUT_LIMITS.url"
              autocomplete="off"
              placeholder="例如：https://mail.example.com"
              @keydown.enter.prevent="submitEditor"
            />
          </el-form-item>
        </el-form>
        <p v-if="mutationError" class="v2-workspace-shortcut-editor__error" role="alert">
          {{ mutationError }}
        </p>
        <footer>
          <AppButton variant="ghost" :disabled="saving" @click="cancelEditor">取消</AppButton>
          <AppButton variant="primary" :loading="saving" @click="submitEditor">
            {{ editorMode === 'create' ? '添加' : '保存' }}
          </AppButton>
        </footer>
      </section>

      <V2AsyncRegion
        :phase="phase"
        :empty="items.length === 0"
        :error="error"
        variant="section"
        skeleton="inline"
        loading-title="正在读取快捷网址"
        refreshing-title="正在更新快捷网址"
        empty-title="还没有快捷网址"
        empty-message="添加后可从左下角工作区快速打开。"
        error-title="快捷网址加载失败"
        @retry="refresh"
      >
        <template #empty-action>
          <AppButton v-if="writesAllowed" variant="primary" size="small" @click="startCreate">
            添加第一个网址
          </AppButton>
        </template>
        <ul class="v2-workspace-shortcut-list" aria-label="快捷网址列表">
          <li v-for="(item, index) in items" :key="item.id">
            <span class="v2-workspace-shortcut-list__mark" aria-hidden="true">
              {{ item.name.slice(0, 1) }}
            </span>
            <div class="v2-workspace-shortcut-list__copy">
              <strong>{{ item.name }}</strong>
              <span>{{ formatUrl(item.url) }}</span>
            </div>
            <div class="v2-workspace-shortcut-list__actions">
              <AppButton
                variant="ghost"
                icon-only
                size="small"
                title="上移"
                :disabled="!writesAllowed || isFirstShortcut(index) || Boolean(mutatingId)"
                @click="moveShortcut(index, -1)"
              >
                <el-icon><ArrowUpBold /></el-icon>
              </AppButton>
              <AppButton
                variant="ghost"
                icon-only
                size="small"
                title="下移"
                :disabled="!writesAllowed || isLastShortcut(index) || Boolean(mutatingId)"
                @click="moveShortcut(index, 1)"
              >
                <el-icon><ArrowDownBold /></el-icon>
              </AppButton>
              <AppButton
                variant="ghost"
                icon-only
                size="small"
                title="修改"
                :disabled="!writesAllowed || Boolean(mutatingId)"
                @click="startEdit(item)"
              >
                <el-icon><Edit /></el-icon>
              </AppButton>
              <AppButton
                variant="ghost"
                icon-only
                size="small"
                title="删除"
                :loading="mutatingId === item.id"
                :disabled="!writesAllowed || Boolean(mutatingId)"
                @click="removeShortcut(item)"
              >
                <el-icon><Delete /></el-icon>
              </AppButton>
            </div>
          </li>
        </ul>
      </V2AsyncRegion>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { computed, reactive, ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import type { V2WorkspaceShortcut } from '@apple-business/shared';
import { V2_WORKSPACE_SHORTCUT_LIMITS } from '@apple-business/shared';
import { ArrowDownBold, ArrowUpBold, Delete, Edit, Plus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';

interface ShortcutForm {
  name: string;
  url: string;
}

const props = defineProps<{
  modelValue: boolean;
  items: V2WorkspaceShortcut[];
  phase: V2QueryPhase;
  error: string;
  writesAllowed: boolean;
  refresh: () => Promise<unknown>;
}>();

defineEmits<{ 'update:modelValue': [value: boolean] }>();

const formRef = ref<FormInstance>();
const editorMode = ref<'create' | 'edit' | null>(null);
const editingId = ref('');
const editorSnapshot = ref('');
const saving = ref(false);
const mutatingId = ref('');
const mutationError = ref('');
const form = reactive<ShortcutForm>({ name: '', url: '' });
const rules: FormRules<ShortcutForm> = {
  name: [
    { required: true, message: '请输入网址名称', trigger: 'blur' },
    {
      max: V2_WORKSPACE_SHORTCUT_LIMITS.name,
      message: `网址名称最多 ${V2_WORKSPACE_SHORTCUT_LIMITS.name} 个字符`,
      trigger: 'blur'
    }
  ],
  url: [
    { required: true, message: '请输入网址', trigger: 'blur' },
    {
      max: V2_WORKSPACE_SHORTCUT_LIMITS.url,
      message: `网址最多 ${V2_WORKSPACE_SHORTCUT_LIMITS.url} 个字符`,
      trigger: 'blur'
    }
  ]
};
const mutationPending = computed(() => saving.value || Boolean(mutatingId.value));
const shortcutLimitReached = computed(
  () => props.items.length >= V2_WORKSPACE_SHORTCUT_LIMITS.count
);
const editorDirty = computed(
  () => Boolean(editorMode.value) && JSON.stringify(form) !== editorSnapshot.value
);

function startCreate() {
  if (shortcutLimitReached.value) return;
  editorMode.value = 'create';
  editingId.value = '';
  Object.assign(form, { name: '', url: '' });
  editorSnapshot.value = JSON.stringify(form);
  mutationError.value = '';
}

function isFirstShortcut(index: number) {
  return index === 0;
}

function isLastShortcut(index: number) {
  return index === props.items.length - 1;
}

function startEdit(item: V2WorkspaceShortcut) {
  editorMode.value = 'edit';
  editingId.value = item.id;
  Object.assign(form, { name: item.name, url: item.url });
  editorSnapshot.value = JSON.stringify(form);
  mutationError.value = '';
}

function resetEditor() {
  editorMode.value = null;
  editingId.value = '';
  Object.assign(form, { name: '', url: '' });
  editorSnapshot.value = '';
  mutationError.value = '';
  formRef.value?.clearValidate();
}

async function cancelEditor() {
  if (editorDirty.value) {
    try {
      await ElMessageBox.confirm('当前网址内容尚未保存，确认放弃吗？', '放弃未保存内容', {
        confirmButtonText: '放弃',
        cancelButtonText: '继续填写',
        type: 'warning'
      });
    } catch {
      return;
    }
  }
  resetEditor();
}

async function submitEditor() {
  if (!props.writesAllowed || saving.value || !(await validateV2Form(formRef.value))) return;
  saving.value = true;
  mutationError.value = '';
  try {
    const input = { name: form.name.trim(), url: form.url.trim() };
    if (editorMode.value === 'edit') {
      await idBusinessV2WorkspaceApi.update(editingId.value, input);
      ElMessage.success('快捷网址已保存');
    } else {
      await idBusinessV2WorkspaceApi.create(input);
      ElMessage.success('快捷网址已添加');
    }
    resetEditor();
    await props.refresh();
  } catch (error) {
    mutationError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function removeShortcut(item: V2WorkspaceShortcut) {
  try {
    await ElMessageBox.confirm(`确认删除快捷网址“${item.name}”吗？`, '删除快捷网址', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning'
    });
  } catch {
    return;
  }
  mutatingId.value = item.id;
  try {
    await idBusinessV2WorkspaceApi.remove(item.id);
    ElMessage.success('快捷网址已删除');
    if (editingId.value === item.id) resetEditor();
    await props.refresh();
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    mutatingId.value = '';
  }
}

async function moveShortcut(index: number, offset: -1 | 1) {
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= props.items.length) return;
  const shortcutIds = props.items.map((item) => item.id);
  [shortcutIds[index], shortcutIds[targetIndex]] = [shortcutIds[targetIndex], shortcutIds[index]];
  mutatingId.value = props.items[index].id;
  try {
    await idBusinessV2WorkspaceApi.reorder({ shortcutIds });
    await props.refresh();
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    mutatingId.value = '';
  }
}

function formatUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

async function handleBeforeClose(done: () => void) {
  if (mutationPending.value) return;
  if (!editorDirty.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('当前网址内容尚未保存，确认关闭吗？', '关闭快捷网址设置', {
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '继续填写',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续填写。
  }
}
</script>

<style>
.v2-workspace-shortcut-drawer .el-drawer__body {
  padding: 0;
}

.v2-workspace-shortcut-drawer__body {
  display: grid;
  min-width: 0;
  gap: 18px;
  padding: 20px;
}

.v2-workspace-shortcut-drawer__toolbar,
.v2-workspace-shortcut-editor > header,
.v2-workspace-shortcut-editor > footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-workspace-shortcut-drawer__toolbar > div,
.v2-workspace-shortcut-editor > header {
  min-width: 0;
}

.v2-workspace-shortcut-drawer__toolbar strong,
.v2-workspace-shortcut-editor > header strong {
  display: block;
  color: var(--v2-text);
  font-size: 15px;
  line-height: 22px;
}

.v2-workspace-shortcut-drawer__toolbar > div > span,
.v2-workspace-shortcut-editor > header > span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-workspace-shortcut-drawer__add.app-button.el-button {
  min-width: 104px;
  flex: 0 0 auto;
}

.v2-workspace-shortcut-drawer__readonly,
.v2-workspace-shortcut-editor__error {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--v3-warning-border-soft);
  border-radius: 6px;
  background: var(--v3-warning-soft);
  color: var(--v2-text);
  font-size: 13px;
}

.v2-workspace-shortcut-editor {
  display: grid;
  gap: 16px;
  padding: 16px 0;
  border-top: 1px solid var(--v2-border);
  border-bottom: 1px solid var(--v2-border);
}

.v2-workspace-shortcut-editor .el-form-item:last-child {
  margin-bottom: 0;
}

.v2-workspace-shortcut-editor__error {
  border-color: var(--v3-danger-border-soft);
  background: var(--v3-danger-soft);
  color: var(--v2-danger);
}

.v2-workspace-shortcut-editor > footer {
  justify-content: flex-end;
}

.v2-workspace-shortcut-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.v2-workspace-shortcut-list > li {
  display: grid;
  min-width: 0;
  min-height: 64px;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-workspace-shortcut-list__mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 6px;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-weight: var(--v3-font-weight-bold);
}

.v2-workspace-shortcut-list__copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-workspace-shortcut-list__copy strong,
.v2-workspace-shortcut-list__copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-workspace-shortcut-list__copy strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-workspace-shortcut-list__copy span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-workspace-shortcut-list__actions {
  display: grid;
  grid-template-columns: repeat(4, 32px);
  gap: 2px;
}

@media (max-width: 520px) {
  .v2-workspace-shortcut-drawer__body {
    padding: 16px;
  }

  .v2-workspace-shortcut-list > li {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .v2-workspace-shortcut-list__actions {
    grid-column: 1 / -1;
    justify-content: end;
  }
}
</style>
