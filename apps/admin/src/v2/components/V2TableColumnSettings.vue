<template>
  <div
    class="v2-table-preference-toolbar"
    :class="{ 'v2-table-preference-toolbar--inline': inline }"
  >
    <AppButton
      size="small"
      variant="ghost"
      :loading="preferencesLoading"
      :disabled="!userId"
      :aria-label="buttonLabel"
      @click="openSettings"
    >
      <el-icon aria-hidden="true"><Setting /></el-icon>
      <span>{{ buttonLabel }}</span>
    </AppButton>
  </div>

  <el-drawer
    v-model="drawerVisible"
    class="v2-table-column-settings"
    title="列显示设置"
    size="440px"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :before-close="beforeClose"
  >
    <div class="v2-table-column-settings__body">
      <p>选择这张表需要显示的列。设置只对当前登录账号生效。</p>
      <el-input v-model.trim="keyword" clearable placeholder="搜索列名称" aria-label="搜索列名称" />

      <div class="v2-table-column-settings__summary">
        <span>已显示 {{ draftVisibleKeys.length }} / {{ dataColumns.length }} 列</span>
        <AppButton size="small" variant="ghost" @click="showAllDraftColumns"> 全部显示 </AppButton>
      </div>

      <el-checkbox-group v-model="draftVisibleKeys" class="v2-table-column-settings__list">
        <el-checkbox v-for="column in filteredColumns" :key="column.key" :value="column.key">
          <span>{{ column.label }}</span>
        </el-checkbox>
      </el-checkbox-group>

      <p v-if="!filteredColumns.length" class="v2-table-column-settings__empty">没有匹配的列。</p>
      <p v-if="saveError" class="v2-table-column-settings__error" role="alert">
        {{ saveError }}
      </p>
    </div>

    <template #footer>
      <div class="v2-table-column-settings__footer">
        <AppButton variant="ghost" :disabled="saving" @click="resetToDefault"> 恢复默认 </AppButton>
        <div>
          <AppButton variant="ghost" :disabled="saving" @click="requestClose">取消</AppButton>
          <AppButton variant="primary" :loading="saving" :disabled="saving" @click="saveSettings">
            保存设置
          </AppButton>
        </div>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, ref } from 'vue';
import { Setting } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import {
  getV2TableHiddenColumnKeys,
  hasV2TablePreference,
  ensureV2TablePreferences,
  resetV2TablePreference,
  saveV2TablePreference,
  useV2TablePreferences
} from '@/v2/composables/useV2TablePreferences';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isV2TableDataColumn, type V2TableSchema } from './tableSystem';

const props = withDefaults(defineProps<{ schema: V2TableSchema; inline?: boolean }>(), {
  inline: false
});
const authStore = useAuthStore();
const { loading: preferencesLoading } = useV2TablePreferences();
const drawerVisible = ref(false);
const keyword = ref('');
const draftVisibleKeys = ref<string[]>([]);
const saving = ref(false);
const saveError = ref('');
const userId = computed(() => authStore.user?.id ?? '');
const dataColumns = computed(() =>
  props.schema.columns.filter((column) => isV2TableDataColumn(column) && column.hideable !== false)
);
const currentHiddenKeys = computed(() => {
  const dataColumnKeys = new Set(dataColumns.value.map((column) => column.key));
  return getV2TableHiddenColumnKeys(props.schema.id, props.schema.defaultHiddenColumnKeys).filter(
    (key) => dataColumnKeys.has(key)
  );
});
const hasCustomPreference = computed(() => hasV2TablePreference(props.schema.id));
const currentVisibleKeys = computed(() =>
  dataColumns.value
    .filter((column) => !currentHiddenKeys.value.includes(column.key))
    .map((column) => column.key)
);
const filteredColumns = computed(() => {
  const normalizedKeyword = keyword.value.toLocaleLowerCase('zh-CN');
  if (!normalizedKeyword) return dataColumns.value;
  return dataColumns.value.filter((column) =>
    column.label.toLocaleLowerCase('zh-CN').includes(normalizedKeyword)
  );
});
const isDirty = computed(
  () => normalizeKeySet(draftVisibleKeys.value) !== normalizeKeySet(currentVisibleKeys.value)
);
const buttonLabel = computed(() =>
  currentHiddenKeys.value.length ? `列设置（隐藏 ${currentHiddenKeys.value.length}）` : '列设置'
);

async function openSettings() {
  if (!userId.value) return;
  try {
    await ensureV2TablePreferences(userId.value);
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
    return;
  }
  draftVisibleKeys.value = [...currentVisibleKeys.value];
  keyword.value = '';
  saveError.value = '';
  drawerVisible.value = true;
}

function showAllDraftColumns() {
  draftVisibleKeys.value = dataColumns.value.map((column) => column.key);
}

async function saveSettings() {
  if (!userId.value || saving.value) return;
  if (!draftVisibleKeys.value.length) {
    saveError.value = '至少保留一列数据列。';
    return;
  }
  if (!isDirty.value) {
    ElMessage.info('列设置没有变化');
    return;
  }
  saving.value = true;
  saveError.value = '';
  const visible = new Set(draftVisibleKeys.value);
  const hiddenColumnKeys = dataColumns.value
    .filter((column) => !visible.has(column.key))
    .map((column) => column.key);
  try {
    await saveV2TablePreference(userId.value, props.schema.id, hiddenColumnKeys);
    draftVisibleKeys.value = [...currentVisibleKeys.value];
    drawerVisible.value = false;
    ElMessage.success('列显示设置已保存');
  } catch (error) {
    saveError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function resetToDefault() {
  if (!userId.value || saving.value) return;
  if (!hasCustomPreference.value) {
    ElMessage.info('当前已经是默认列设置');
    return;
  }
  try {
    await ElMessageBox.confirm('恢复后，这张表将按系统默认列显示。', '恢复默认列设置', {
      confirmButtonText: '确认恢复',
      cancelButtonText: '取消',
      type: 'warning'
    });
  } catch {
    return;
  }

  saving.value = true;
  saveError.value = '';
  try {
    await resetV2TablePreference(userId.value, props.schema.id);
    draftVisibleKeys.value = dataColumns.value
      .filter((column) => !props.schema.defaultHiddenColumnKeys?.includes(column.key))
      .map((column) => column.key);
    drawerVisible.value = false;
    ElMessage.success('已恢复默认列设置');
  } catch (error) {
    saveError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

function requestClose() {
  void beforeClose(() => {
    drawerVisible.value = false;
  });
}

async function beforeClose(done: () => void) {
  if (saving.value) return;
  if (!isDirty.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('当前列设置尚未保存，确定放弃修改吗？', '放弃未保存设置', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续编辑',
      type: 'warning'
    });
    done();
  } catch {
    // Keep the drawer open so the current draft is not lost.
  }
}

function normalizeKeySet(keys: readonly string[]) {
  return [...new Set(keys)].sort().join('\u0000');
}
</script>
