<template>
  <section class="v2-records-page bank-recharge-page">
    <V2PageContext
      description="按国家管理充值代理 IP；充值时先选择币种，再选择国家及该国启用的代理。"
    >
      <template #actions>
        <AppButton @click="openImport">批量导入</AppButton>
        <AppButton variant="primary" @click="openCreate">新增代理 IP</AppButton>
      </template>
    </V2PageContext>
    <el-form
      class="recharge-proxy-filters"
      inline
      label-position="left"
      require-asterisk-position="right"
      @submit.prevent="search"
    >
      <el-form-item label="搜索"
        ><el-input
          v-model="keywordInput"
          clearable
          placeholder="国家代码或备注"
          @keyup.enter="search"
      /></el-form-item>
      <el-form-item label="国家">
        <el-select
          v-model="countryInput"
          filterable
          clearable
          aria-label="筛选代理国家"
          placeholder="全部国家"
        >
          <el-option
            v-for="[code, label] in proxyCountries"
            :key="code"
            :value="code"
            :label="label"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="IP 属性">
        <el-select v-model="kindInput" clearable aria-label="筛选代理属性" placeholder="全部属性">
          <el-option
            v-for="[value, label] in kindOptions"
            :key="value"
            :value="value"
            :label="label"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="statusInput" aria-label="筛选代理状态" placeholder="全部状态">
          <el-option label="全部状态" value="" /><el-option label="启用" value="active" /><el-option
            label="停用"
            value="disabled"
          />
        </el-select>
      </el-form-item>
      <el-form-item><AppButton @click="search">搜索</AppButton></el-form-item>
    </el-form>
    <p v-if="operationError" class="bank-recharge-error" role="alert">{{ operationError }}</p>
    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载代理 IP"
      @retry="query.refresh"
    >
      <section class="v2-records-list">
        <header>
          <V2SectionHeading title="代理 IP 清单"
            ><template #actions
              ><V2TableColumnSettings inline :schema="v2TableSchemas.rechargeProxies.main" /><span
                >共 {{ query.data.value?.total ?? 0 }} 条</span
              ></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="v2TableSchemas.rechargeProxies.main"
          :show-column-settings="false"
          :data="items"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无代理 IP</strong><span>新增或导入后可在充值时选择</span>
            </div></template
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[0]"
            ><template #default="{ row }">{{
              proxyCountryLabel(row.countryCode)
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[1]"
            ><template #default="{ row }">{{ proxyKindLabel(row.kind) }}</template></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.rechargeProxies.main.columns[2]"
            prop="linkMask"
          />
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[3]"
            ><template #default="{ row }"
              ><el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="plain">{{
                row.status === 'active' ? '启用' : '停用'
              }}</el-tag></template
            ></V2TableColumn
          >
          <V2TableColumn
            :definition="v2TableSchemas.rechargeProxies.main.columns[4]"
            prop="remark1"
            show-overflow-tooltip
          />
          <V2TableColumn
            :definition="v2TableSchemas.rechargeProxies.main.columns[5]"
            prop="remark2"
            show-overflow-tooltip
          />
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[6]"
            ><template #default="{ row }">{{
              formatV2DateTime(row.updatedAt)
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[7]">
            <template #default="{ row }">{{ proxyProtocolLabel(row.protocol) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.rechargeProxies.main.columns[8]">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="detailId = row.id">详细</AppButton>
              <el-dropdown trigger="click"
                ><AppButton size="small" variant="ghost" :disabled="working">更多操作</AppButton>
                <template #dropdown
                  ><el-dropdown-menu>
                    <el-dropdown-item @click="openEdit(row)">编辑</el-dropdown-item>
                    <el-dropdown-item @click="changeStatus(row)">{{
                      row.status === 'active' ? '停用' : '启用'
                    }}</el-dropdown-item>
                    <el-dropdown-item @click="openDelete(row)">删除</el-dropdown-item>
                  </el-dropdown-menu></template
                >
              </el-dropdown>
            </template>
          </V2TableActionColumn>
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="query.data.value?.page ?? page"
            :page-size="query.data.value?.pageSize ?? pageSize"
            :page-sizes="[20, 50, 100]"
            :total="query.data.value?.total ?? 0"
            background
            layout="sizes, prev, pager, next"
            @current-change="page = $event"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <V2FormDrawer
      v-model="formOpen"
      :title="editing ? '编辑代理 IP' : '新增代理 IP'"
      description="国家、协议和链接统一在这里维护，供服务器默认设置与充值选择使用。已用于充值的代理不能更换国家、属性、协议或链接。"
      size="min(700px, 96vw)"
      :confirm-loading="saving"
      :dirty="dirty"
      @confirm="save"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="110px"
        require-asterisk-position="right"
        autocomplete="off"
      >
        <el-form-item label="国家" prop="countryCode"
          ><el-select
            v-model="form.countryCode"
            filterable
            allow-create
            default-first-option
            aria-label="代理国家"
            placeholder="选择国家或输入两位国家代码"
            ><el-option
              v-for="[code, label] in proxyCountries"
              :key="code"
              :value="code"
              :label="label" /></el-select
        ></el-form-item>
        <el-form-item label="代理协议" prop="protocol" required>
          <el-select v-model="form.protocol" aria-label="代理协议">
            <el-option
              v-for="[value, label] in Object.entries(proxyProtocolLabels)"
              :key="value"
              :value="value"
              :label="label"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="IP 链接" prop="url" :required="!editing"
          ><el-input
            v-model="form.url"
            maxlength="2000"
            autocomplete="off"
            :placeholder="
              editing ? '留空保留当前链接' : 'HTTPS 提取链接或协议://账号:密码@主机:端口'
            "
        /></el-form-item>
        <p class="bank-recharge-form-note">
          HTTPS
          提取链接负责获取代理；代理协议请选择供应商实际提供的协议。直连链接的协议须与选择一致。
        </p>
        <AppButton v-if="editing" size="small" variant="ghost" @click="detailId = editing.id"
          >查看已保存链接</AppButton
        >
        <el-form-item label="IP 属性" prop="kind"
          ><el-select v-model="form.kind" aria-label="代理属性"
            ><el-option
              v-for="[value, label] in kindOptions"
              :key="value"
              :value="value"
              :label="label" /></el-select
        ></el-form-item>
        <el-form-item label="备注1"
          ><el-input v-model="form.remark1" maxlength="500"
        /></el-form-item>
        <el-form-item label="备注2"
          ><el-input v-model="form.remark2" maxlength="500"
        /></el-form-item>
      </el-form>
      <p v-if="formError" class="bank-recharge-error" role="alert">{{ formError }}</p>
    </V2FormDrawer>

    <RechargeProxyImportDrawer
      v-if="importOpen"
      @close="importOpen = false"
      @imported="onImported"
    />

    <V2ConfirmDialog
      v-model="deleteOpen"
      title="删除代理 IP"
      message=""
      confirm-text="删除代理 IP"
      :confirm-loading="working"
      danger
      @confirm="confirmDelete"
    >
      <p>
        确认删除 {{ deleting ? proxyCountryLabel(deleting.countryCode) : '' }} 的代理
        IP？已用于充值任务的代理不能删除，请停用。
      </p>
      <p v-if="deleteError" class="bank-recharge-error" role="alert">{{ deleteError }}</p>
    </V2ConfirmDialog>
    <V2RechargeProxyDetailDrawer v-if="detailId" :id="detailId" @close="detailId = null" />
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { validateV2Form } from '@/v2/utils/formValidation';
import { rechargeProxyApi, type RechargeProxyItem } from './recharge-proxy-api';
import {
  parseProxyCountry,
  proxyCountries,
  proxyCountryLabel,
  proxyKindLabel,
  proxyKindLabels,
  proxyProtocolLabel,
  proxyProtocolLabels,
  type ProxyProtocol,
  type ProxyKind
} from './recharge-proxy-options';
import V2RechargeProxyDetailDrawer from './V2RechargeProxyDetailDrawer.vue';
import '@/v2/styles/records.css';
import './bank-recharge.css';
const RechargeProxyImportDrawer = defineAsyncComponent(
  () => import('./RechargeProxyImportDrawer.vue')
);

const kindOptions = Object.entries(proxyKindLabels) as [ProxyKind, string][];
const page = ref(1);
const pageSize = ref(20);
const keywordInput = ref('');
const countryInput = ref('');
const kindInput = ref('');
const statusInput = ref('');
const keyword = ref('');
const countryCode = ref('');
const kind = ref('');
const status = ref('');
const query = useV2ModuleQuery({
  moduleKey: 'recharge-proxies',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      countryCode: countryCode.value,
      kind: kind.value,
      status: status.value
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    rechargeProxyApi.list(
      {
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value,
        countryCode: countryCode.value,
        kind: kind.value,
        status: status.value
      },
      { signal }
    )
});
watch([page, pageSize, keyword, countryCode, kind, status], () => {
  void query.ensureFresh();
});
const items = computed(() => query.data.value?.items ?? []);
const formOpen = ref(false);
const editing = ref<RechargeProxyItem | null>(null);
const formRef = ref<FormInstance>();
const form = reactive<{
  countryCode: string;
  url: string;
  kind: ProxyKind | '';
  protocol: ProxyProtocol;
  remark1: string;
  remark2: string;
}>({ countryCode: '', url: '', kind: '', protocol: 'http', remark1: '', remark2: '' });
const original = ref('');
const dirty = computed(() => JSON.stringify(form) !== original.value);
const rules: FormRules = {
  countryCode: [{ required: true, message: '请选择国家', trigger: 'change' }],
  url: [{ required: false, trigger: 'blur' }],
  kind: [{ required: true, message: '请选择 IP 属性', trigger: 'change' }],
  protocol: [{ required: true, message: '请选择代理协议', trigger: 'change' }]
};
const saving = ref(false);
const formError = ref('');
const importOpen = ref(false);
const operationError = ref('');
const working = ref(false);
const deleteOpen = ref(false);
const deleting = ref<RechargeProxyItem | null>(null);
const deleteError = ref('');
const detailId = ref<string | null>(null);

function search() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
  countryCode.value = countryInput.value;
  kind.value = kindInput.value;
  status.value = statusInput.value;
}
function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
}
function resetForm() {
  Object.assign(form, {
    countryCode: '',
    url: '',
    kind: '',
    protocol: 'http',
    remark1: '',
    remark2: ''
  });
  formError.value = '';
  original.value = JSON.stringify(form);
}
function openCreate() {
  editing.value = null;
  resetForm();
  formOpen.value = true;
}
function openEdit(item: RechargeProxyItem) {
  editing.value = item;
  resetForm();
  Object.assign(form, {
    countryCode: item.countryCode,
    kind: item.kind,
    protocol: item.protocol,
    remark1: item.remark1 ?? '',
    remark2: item.remark2 ?? ''
  });
  original.value = JSON.stringify(form);
  formOpen.value = true;
}
async function save() {
  if (saving.value || !(await validateV2Form(formRef.value))) return;
  saving.value = true;
  formError.value = '';
  try {
    const country = parseProxyCountry(form.countryCode);
    if (!form.kind) throw new Error('请选择 IP 属性');
    if (!editing.value && !form.url.trim()) throw new Error('请填写 IP 链接');
    const input = {
      countryCode: country,
      kind: form.kind,
      protocol: form.protocol,
      remark1: form.remark1,
      remark2: form.remark2
    };
    if (editing.value)
      await rechargeProxyApi.update(editing.value.id, {
        ...input,
        ...(form.url.trim() ? { url: form.url.trim() } : {})
      });
    else await rechargeProxyApi.create({ ...input, url: form.url.trim() });
    form.url = '';
    formOpen.value = false;
    ElMessage.success('代理 IP 已保存');
    await query.refresh();
  } catch (cause) {
    formError.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
function openImport() {
  importOpen.value = true;
}
async function onImported(count: number) {
  importOpen.value = false;
  page.value = 1;
  keyword.value = '';
  keywordInput.value = '';
  countryCode.value = '';
  countryInput.value = '';
  kind.value = '';
  kindInput.value = '';
  status.value = '';
  statusInput.value = '';
  ElMessage.success(`已导入 ${count} 条代理 IP`);
  await query.refresh();
}
async function changeStatus(item: RechargeProxyItem) {
  if (working.value) return;
  working.value = true;
  operationError.value = '';
  try {
    await rechargeProxyApi.update(item.id, {
      status: item.status === 'active' ? 'disabled' : 'active'
    });
    ElMessage.success(item.status === 'active' ? '代理 IP 已停用' : '代理 IP 已启用');
    await query.refresh();
  } catch (cause) {
    operationError.value = getApiErrorMessage(cause);
  } finally {
    working.value = false;
  }
}
function openDelete(item: RechargeProxyItem) {
  deleting.value = item;
  deleteError.value = '';
  deleteOpen.value = true;
}
async function confirmDelete() {
  if (!deleting.value || working.value) return;
  working.value = true;
  deleteError.value = '';
  try {
    await rechargeProxyApi.delete(deleting.value.id);
    deleteOpen.value = false;
    deleting.value = null;
    ElMessage.success('代理 IP 已删除');
    await query.refresh();
  } catch (cause) {
    deleteError.value = getApiErrorMessage(cause);
  } finally {
    working.value = false;
  }
}
</script>
