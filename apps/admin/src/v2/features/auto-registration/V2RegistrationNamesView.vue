<template>
  <section class="v2-page-layout v2-records-page">
    <V2PageContext
      description="保存用于注册资料的展示名字，自动选择启用项；出生日期在每次注册时确认。"
    >
      <template #filters
        ><el-form
          inline
          label-position="left"
          require-asterisk-position="right"
          @submit.prevent="search"
        >
          <el-form-item label="搜索"
            ><el-input v-model="filters.keyword" placeholder="名字" clearable @keyup.enter="search"
          /></el-form-item>
          <el-form-item label="状态"
            ><el-select v-model="filters.status"
              ><el-option label="全部" value="all" /><el-option
                label="启用"
                value="active" /><el-option label="停用" value="disabled" /></el-select
          ></el-form-item>
          <el-form-item><AppButton @click="search">查询</AppButton></el-form-item>
        </el-form></template
      >
      <template #actions
        ><AppButton @click="openImport">批量导入</AppButton
        ><AppButton variant="primary" @click="openEditor()">新增名字</AppButton></template
      >
    </V2PageContext>
    <p v-if="message" role="status">{{ message }}</p>
    <V2AsyncRegion
      skeleton="table"
      loading-title="正在加载列表"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      @retry="query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="名字清单"
            ><template #actions
              ><V2TableColumnSettings inline :schema="v2TableSchemas.registrationNames.main" /><span
                >共 {{ query.data.value?.total ?? 0 }} 条</span
              ></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="v2TableSchemas.registrationNames.main"
          :show-column-settings="false"
          :data="query.data.value?.items ?? []"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无名字</strong><span>新增或导入后可用于注册资料</span>
            </div></template
          >
          <V2TableColumn
            :definition="v2TableSchemas.registrationNames.main.columns[0]"
            prop="displayName"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.registrationNames.main.columns[1]"
            ><template #default="{ row }">{{
              row.active ? '启用' : '停用'
            }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.registrationNames.main.columns[2]"
            prop="usageCount"
          />
          <V2TableColumn :definition="v2TableSchemas.registrationNames.main.columns[3]"
            ><template #default="{ row }">{{
              formatV2DateTime(row.updatedAt)
            }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.registrationNames.main.columns[4]"
            ><template #default="{ row }"
              ><AppButton size="small" variant="ghost" @click="openEditor(row)"
                >编辑</AppButton
              ></template
            ></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 条</span
          ><el-pagination
            v-pagination-label
            :current-page="filters.page"
            :page-size="filters.pageSize"
            :total="query.data.value?.total ?? 0"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <V2FormDrawer
      v-model="editorOpen"
      :title="editingId ? '修改名字' : '新增名字'"
      :confirm-loading="saving"
      @confirm="save"
    >
      <p v-if="error" role="alert">{{ error }}</p>
      <el-form
        ref="editorRef"
        :model="editor.form"
        :rules="editorRules"
        scroll-to-error
        label-position="left"
        label-width="100px"
        require-asterisk-position="right"
      >
        <el-form-item label="名字" prop="displayName"
          ><el-input v-model="editor.form.displayName" maxlength="120"
        /></el-form-item>
        <el-form-item label="启用状态" prop="active"
          ><el-switch v-model="editor.form.active" active-text="启用" inactive-text="停用"
        /></el-form-item>
      </el-form>
    </V2FormDrawer>
    <V2FormDrawer
      v-model="importOpen"
      title="批量导入名字"
      :confirm-loading="saving"
      confirm-text="导入"
      @confirm="importNames"
    >
      <p v-if="error" role="alert">{{ error }}</p>
      <el-form
        ref="importRef"
        :model="importDraft.form"
        :rules="importRules"
        scroll-to-error
        label-position="left"
        label-width="100px"
        require-asterisk-position="right"
      >
        <el-form-item label="名字列表" prop="names"
          ><el-input
            v-model="importDraft.form.names"
            type="textarea"
            :rows="10"
            maxlength="250000"
            placeholder="每行一个名字，每次最多 2000 个；重复名字会跳过"
        /></el-form-item>
      </el-form>
    </V2FormDrawer>
  </section>
</template>
<script setup lang="ts">
import '@/v2/styles/records.css';
import { ref, watch, reactive } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { validateV2Form } from '@/v2/utils/formValidation';
import { getApiErrorMessage } from '@/api/client';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { registrationApi } from './api';
import type { V2RegistrationName } from './contracts';
const filters = useV2SessionDraft('registration-names:filters', () =>
  reactive({ page: 1, pageSize: 20, keyword: '', status: 'all', appliedKeyword: '' })
);
const query = useV2ModuleQuery({
  moduleKey: 'registration-names',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: filters.page,
      pageSize: filters.pageSize,
      status: filters.status,
      keyword: filters.appliedKeyword
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    registrationApi.names({ ...filters, keyword: filters.appliedKeyword }, { signal })
});
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => query.data.value?.items ?? [],
  pageSize: () => filters.pageSize
});
watch(
  () => [filters.page, filters.pageSize, filters.status, filters.appliedKeyword],
  () => {
    void query.ensureFresh();
  }
);
watch(
  () => [filters.pageSize, filters.status],
  () => {
    filters.page = 1;
  }
);
function changePage(value: number) {
  filters.page = value;
}
function changePageSize(value: number) {
  filters.pageSize = value;
}
function search() {
  filters.page = 1;
  filters.appliedKeyword = filters.keyword.trim();
}
const editorOpen = ref(false),
  importOpen = ref(false),
  saving = ref(false),
  editingId = ref<string | null>(null),
  error = ref(''),
  message = ref('');
const editorRef = ref<FormInstance>(),
  importRef = ref<FormInstance>();
const editor = useV2FormDraft('registration-name:editor', () => ({
  displayName: '',
  active: true
}));
const importDraft = useV2FormDraft('registration-name:import', () => ({ names: '' }));
const editorRules: FormRules = {
  displayName: [
    { required: true, message: '请输入名字', trigger: 'blur' },
    { max: 120, message: '名字最多 120 个字符', trigger: 'blur' }
  ]
};
const importRules: FormRules = {
  names: [{ required: true, message: '请输入名字列表', trigger: 'blur' }]
};
function openEditor(row?: V2RegistrationName) {
  editingId.value = row?.id ?? null;
  editor.open(
    row?.id ?? 'create',
    row ? { displayName: row.displayName, active: row.active } : {},
    row?.updatedAt
  );
  error.value = '';
  editorOpen.value = true;
}
function openImport() {
  importDraft.open('import');
  error.value = '';
  importOpen.value = true;
}
async function save() {
  if (!(await validateV2Form(editorRef.value))) return;
  const completeSave = editor.beginSave();
  saving.value = true;
  error.value = '';
  try {
    await registrationApi.writeName(editingId.value, {
      ...editor.form,
      expectedUpdatedAt: editor.version.value
    });
    completeSave();
    editorOpen.value = false;
    message.value = '名字已保存';
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function importNames() {
  if (!(await validateV2Form(importRef.value))) return;
  const names = importDraft.form.names
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!names.length || names.length > 2000 || names.some((name) => name.length > 120)) {
    error.value = '每次导入 1 至 2000 个名字，每个最多 120 个字符';
    return;
  }
  const completeSave = importDraft.beginSave();
  saving.value = true;
  error.value = '';
  try {
    const result = await registrationApi.importNames(names);
    completeSave();
    importOpen.value = false;
    message.value = `已导入 ${result.imported} 个名字，跳过 ${result.skipped} 个重复项`;
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
