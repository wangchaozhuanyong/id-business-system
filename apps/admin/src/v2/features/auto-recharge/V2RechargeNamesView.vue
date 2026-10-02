<template>
  <section class="v2-page-layout v2-records-page bank-recharge-page">
    <V2PageContext
      description="新银行卡优先匹配未使用姓名，用完后按录入顺序循环。旧卡保持原绑定；停用姓名不参与新匹配。"
    >
      <template #filters>
        <el-form
          inline
          label-position="left"
          require-asterisk-position="right"
          @submit.prevent="search"
        >
          <el-form-item label="姓名搜索"
            ><el-input
              v-model="state.keywordInput"
              placeholder="输入完整姓名"
              clearable
              @keyup.enter="search"
          /></el-form-item>
          <el-form-item label="状态"
            ><el-select v-model="state.status" aria-label="姓名状态"
              ><el-option label="全部" value="" /><el-option
                label="启用"
                value="active" /><el-option label="停用" value="disabled" /></el-select
          ></el-form-item>
          <el-form-item><AppButton @click="search">搜索</AppButton></el-form-item>
        </el-form>
      </template>
      <template #actions
        ><AppButton variant="primary" @click="openImport">录入／批量导入</AppButton></template
      >
    </V2PageContext>
    <p v-if="operationError" class="bank-recharge-error" role="alert">{{ operationError }}</p>
    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载姓名库"
      @retry="query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="姓名清单"
            ><template #actions
              ><V2TableColumnSettings inline :schema="v2TableSchemas.autoRechargeNames.main" /><span
                >共 {{ query.data.value?.total ?? 0 }} 个</span
              ></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="v2TableSchemas.autoRechargeNames.main"
          :data="query.data.value?.items ?? []"
          :show-column-settings="false"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无姓名</strong><span>录入姓名后，充值时会自动匹配</span>
            </div></template
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeNames.main.columns[0]"
            prop="sequence"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeNames.main.columns[1]"
            prop="name"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.autoRechargeNames.main.columns[2]"
            ><template #default="{ row }"
              ><el-tag :type="row.active ? 'success' : 'info'" effect="plain">{{
                row.active ? '启用' : '停用'
              }}</el-tag></template
            ></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeNames.main.columns[3]"
            prop="matchCount"
          />
          <V2TableColumn :definition="v2TableSchemas.autoRechargeNames.main.columns[4]"
            ><template #default="{ row }">{{
              row.lastMatchedAt ? formatV2DateTime(row.lastMatchedAt) : '未使用'
            }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.autoRechargeNames.main.columns[5]"
            ><template #default="{ row }"
              ><AppButton size="small" variant="ghost" @click="openEdit(row)">编辑</AppButton
              ><AppButton
                size="small"
                variant="ghost"
                :disabled="working"
                @click="changeStatus(row)"
                >{{ row.active ? '停用' : '启用' }}</AppButton
              ></template
            ></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 个</span
          ><el-pagination
            v-pagination-label
            :current-page="state.page"
            :page-size="state.pageSize"
            :page-sizes="[20, 50, 100]"
            :total="query.data.value?.total ?? 0"
            layout="sizes, prev, pager, next"
            background
            @current-change="state.page = $event"
            @size-change="
              state.pageSize = $event;
              state.page = 1;
            "
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <V2FormDrawer
      v-model="importOpen"
      retain-draft
      title="录入姓名"
      description="每行一个姓名，最多 2000 行；重复姓名自动跳过。请录入与付款资料相符的姓名。"
      :confirm-loading="saving"
      @confirm="saveImport"
    >
      <el-form label-position="left" label-width="100px" require-asterisk-position="right"
        ><el-form-item label="姓名列表" required
          ><el-input
            v-model="importDraft.form.text"
            type="textarea"
            :rows="10"
            maxlength="250000"
            placeholder="每行输入一个姓名" /></el-form-item
      ></el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
    <V2FormDrawer
      v-model="editOpen"
      retain-draft
      title="编辑姓名"
      description="修改仅影响以后新匹配的银行卡，历史绑定保持原姓名。"
      :confirm-loading="saving"
      @confirm="saveEdit"
    >
      <el-form label-position="left" label-width="100px" require-asterisk-position="right"
        ><el-form-item label="姓名" required
          ><el-input v-model="editDraft.form.name" maxlength="120" /></el-form-item
      ></el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
  </section>
</template>
<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { useV2SessionDraft, useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery, createV2QueryKey } from '@/v2/composables/useV2Query';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { rechargeNameApi, type RechargeNameItem } from './recharge-name-api';
import '@/v2/styles/records.css';
import './bank-recharge.css';

const state = useV2SessionDraft('recharge-names-list', () =>
  reactive({ page: 1, pageSize: 20, keyword: '', keywordInput: '', status: '' })
);
const query = useV2ModuleQuery({
  moduleKey: 'auto-recharge-names',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: state.page,
      pageSize: state.pageSize,
      keyword: state.keyword,
      status: state.status
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    rechargeNameApi.list(
      { page: state.page, pageSize: state.pageSize, keyword: state.keyword, status: state.status },
      { signal }
    )
});
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => query.data.value?.items ?? [],
  pageSize: () => state.pageSize
});
watch(
  () => state.status,
  () => {
    state.page = 1;
  }
);
function search() {
  state.keyword = state.keywordInput.trim();
  state.page = 1;
}
const importOpen = ref(false),
  editOpen = ref(false),
  saving = ref(false),
  working = ref(false),
  saveError = ref(''),
  operationError = ref('');
const editingId = ref('');
const importDraft = useV2FormDraft('recharge-names-import', () => ({ text: '' }));
const editDraft = useV2FormDraft('recharge-names-editor', () => ({ name: '' }));
function openImport() {
  importDraft.open('import');
  saveError.value = '';
  importOpen.value = true;
}
function openEdit(row: RechargeNameItem) {
  editingId.value = row.id;
  editDraft.open(row.id, { name: row.name }, row.updatedAt);
  saveError.value = '';
  editOpen.value = true;
}
async function saveImport() {
  if (saving.value) return;
  const names = importDraft.form.text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!names.length || names.length > 2000 || names.some((name) => name.length > 120)) {
    saveError.value = '请输入 1 至 2000 行姓名，每个姓名最多 120 个字符';
    return;
  }
  const complete = importDraft.beginSave();
  saving.value = true;
  saveError.value = '';
  try {
    const result = await rechargeNameApi.import(names);
    if (complete()) importOpen.value = false;
    ElMessage.success(`已录入 ${result.imported} 个姓名，跳过 ${result.skipped} 个重复项`);
    await query.refresh();
  } catch (error) {
    saveError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}
async function saveEdit() {
  if (saving.value) return;
  if (!editDraft.form.name.trim()) {
    saveError.value = '请输入姓名';
    return;
  }
  const id = editingId.value,
    complete = editDraft.beginSave();
  saving.value = true;
  saveError.value = '';
  try {
    await rechargeNameApi.update(id, {
      name: editDraft.form.name.trim(),
      expectedUpdatedAt: editDraft.version.value!
    });
    if (complete() && editingId.value === id) editOpen.value = false;
    ElMessage.success('姓名已保存');
    await query.refresh();
  } catch (error) {
    saveError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}
async function changeStatus(row: RechargeNameItem) {
  if (working.value) return;
  working.value = true;
  operationError.value = '';
  try {
    await rechargeNameApi.update(row.id, { active: !row.active, expectedUpdatedAt: row.updatedAt });
    await query.refresh();
  } catch (error) {
    operationError.value = getApiErrorMessage(error);
  } finally {
    working.value = false;
  }
}
</script>
