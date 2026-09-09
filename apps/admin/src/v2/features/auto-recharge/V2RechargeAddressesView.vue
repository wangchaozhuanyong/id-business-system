<template>
  <section class="v2-records-page recharge-address-page">
    <V2PageContext
      description="批量维护自动充值地址。地区信息由系统固定，导入文件每行只填写一个街道地址。"
    >
      <template #meta
        ><span>自动充值</span><span aria-hidden="true">/</span><span>地址管理</span></template
      >
      <template #status>
        <span>未使用 {{ data?.totals.unused ?? 0 }}</span>
        <span>已使用 {{ data?.totals.used ?? 0 }}</span>
        <span>已停用 {{ data?.totals.disabled ?? 0 }}</span>
      </template>
    </V2PageContext>

    <el-alert
      title="固定地区：美国（官网选择 United States）· Portland · OR · 97204。充值页只提供未使用地址，开通成功后自动标记已使用。"
      type="info"
      :closable="false"
      show-icon
    />

    <section class="recharge-address-import" aria-labelledby="recharge-address-import-title">
      <V2SectionHeading id="recharge-address-import-title" title="批量导入">
        <template #actions><span>支持 TXT，每次最多 2000 行</span></template>
      </V2SectionHeading>
      <el-form
        label-position="left"
        label-width="90px"
        require-asterisk-position="right"
        @submit.prevent
      >
        <el-form-item label="固定地区">
          <div class="recharge-address-location">
            <span>国家 United States（代码 US）</span><span>城市 Portland</span><span>州 OR</span
            ><span>邮编 97204</span>
          </div>
        </el-form-item>
        <el-form-item label="地址文件" required>
          <div class="recharge-address-file-row">
            <label class="recharge-address-file-picker" :class="{ 'is-disabled': importing }">
              {{ fileName || '选择 TXT 文件' }}
              <input
                type="file"
                accept=".txt,text/plain"
                :disabled="importing"
                aria-label="选择街道地址文件"
                @change="loadFile"
              />
            </label>
            <span v-if="pendingStreets.length">已读取 {{ pendingStreets.length }} 行</span>
            <AppButton
              variant="primary"
              :loading="importing"
              :disabled="importing"
              @click="importAddresses"
            >
              导入地址
            </AppButton>
          </div>
        </el-form-item>
      </el-form>
      <p v-if="operationMessage" class="recharge-address-message" role="status">
        {{ operationMessage }}
      </p>
      <p v-if="operationError" class="recharge-address-error" role="alert">
        {{ operationError }}
      </p>
    </section>

    <section class="recharge-address-toolbar" aria-label="地址筛选">
      <el-input
        v-model="keywordInput"
        clearable
        aria-label="搜索街道地址"
        placeholder="搜索街道地址"
        @keyup.enter="applyFilters"
        @clear="applyFilters"
      />
      <el-select v-model="statusInput" aria-label="地址状态">
        <el-option label="全部状态" value="all" />
        <el-option label="未使用" value="unused" />
        <el-option label="已使用" value="used" />
        <el-option label="已停用" value="disabled" />
      </el-select>
      <AppButton variant="soft" @click="applyFilters">查询</AppButton>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在加载地址"
      refreshing-title="正在更新地址"
      error-title="地址加载失败"
      @retry="query.refresh"
    >
      <section class="v2-records-list recharge-address-list">
        <header>
          <V2SectionHeading title="地址清单">
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.autoRechargeAddresses.main" />
              <span>共 {{ data?.total ?? 0 }} 条</span>
            </template>
          </V2SectionHeading>
        </header>

        <V2Table
          :schema="v2TableSchemas.autoRechargeAddresses.main"
          :show-column-settings="false"
          :view-key="`${page}:${pageSize}:${keyword}:${status}`"
          :data="data?.items ?? []"
          :aria-busy="query.isRefreshing.value"
          class="v2-records-table"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无地址</strong>
              <span>{{
                keyword || status !== 'all' ? '当前筛选条件下没有数据' : '请先导入 TXT 地址文件'
              }}</span>
            </div>
          </template>
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[0]"
            prop="line1"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[1]"
            prop="city"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[2]"
            prop="state"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[3]"
            prop="postalCode"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[4]"
            prop="country"
          />
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[5]"
            prop="status"
          >
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status)" effect="plain">{{
                statusLabel(row.status)
              }}</el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[6]"
            prop="usedAt"
          >
            <template #default="{ row }">{{
              row.usedAt ? formatV2DateTime(row.usedAt) : '—'
            }}</template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.autoRechargeAddresses.main.columns[7]"
            prop="createdAt"
          >
            <template #default="{ row }">{{ formatV2DateTime(row.createdAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.autoRechargeAddresses.main.columns[8]">
            <template #default="{ row }">
              <template v-if="row.status !== 'used'">
                <AppButton size="small" variant="ghost" @click="openStatusDialog(row, 'used')">
                  标记已使用
                </AppButton>
                <AppButton
                  size="small"
                  variant="ghost"
                  @click="openStatusDialog(row, row.status === 'disabled' ? 'unused' : 'disabled')"
                >
                  {{ row.status === 'disabled' ? '启用' : '停用' }}
                </AppButton>
              </template>
              <span v-else class="recharge-address-locked">不可恢复</span>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <footer class="v2-records-pagination">
          <span>共 {{ data?.total ?? 0 }} 条</span>
          <el-pagination
            v-pagination-label
            :current-page="page"
            :page-size="pageSize"
            :page-sizes="[20, 50, 100]"
            :total="data?.total ?? 0"
            background
            layout="sizes, prev, pager, next"
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <V2ConfirmDialog
      v-model="statusDialogOpen"
      :title="pendingStatus === 'used' ? '标记地址已使用' : '更新地址状态'"
      :message="statusDialogMessage"
      confirm-text="确认"
      :confirm-loading="updating"
      @confirm="confirmStatusUpdate"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { rechargeApi } from './api';
import type { V2RechargeAddress, V2RechargeAddressStatus } from './contracts';
import '@/v2/styles/records.css';
import './recharge-addresses.css';

const page = ref(1);
const pageSize = ref(20);
const keywordInput = ref('');
const statusInput = ref<V2RechargeAddressStatus | 'all'>('all');
const keyword = ref('');
const status = ref<V2RechargeAddressStatus | 'all'>('all');
const pendingStreets = ref<string[]>([]);
const fileName = ref('');
const importing = ref(false);
const updating = ref(false);
const operationMessage = ref('');
const operationError = ref('');
const statusDialogOpen = ref(false);
const pendingAddress = ref<V2RechargeAddress>();
const pendingStatus = ref<V2RechargeAddressStatus>('unused');

const query = useV2ModuleQuery({
  moduleKey: 'auto-recharge-addresses',
  scope: 'auto-recharge',
  key: () =>
    createV2QueryKey({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value,
      status: status.value
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    rechargeApi.listAddresses(
      { page: page.value, pageSize: pageSize.value, keyword: keyword.value, status: status.value },
      { signal }
    )
});
const data = computed(() => query.data.value);
const statusDialogMessage = computed(() => {
  if (!pendingAddress.value) return '';
  if (pendingStatus.value === 'used')
    return `确认将“${pendingAddress.value.line1}”标记为已使用？该状态不能恢复。`;
  return `确认${pendingStatus.value === 'disabled' ? '停用' : '启用'}“${pendingAddress.value.line1}”？`;
});

function statusLabel(value: V2RechargeAddressStatus) {
  return { unused: '未使用', used: '已使用', disabled: '已停用' }[value];
}
function statusTag(value: V2RechargeAddressStatus): 'success' | 'info' | 'warning' {
  return value === 'unused' ? 'success' : value === 'used' ? 'info' : 'warning';
}
function applyFilters() {
  page.value = 1;
  keyword.value = keywordInput.value.trim();
  status.value = statusInput.value;
}
function changePage(value: number) {
  page.value = value;
}
function changePageSize(value: number) {
  pageSize.value = value;
  page.value = 1;
}
async function loadFile(event: Event) {
  operationMessage.value = '';
  operationError.value = '';
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 256_000) {
    operationError.value = 'TXT 文件不能超过 256 KB';
    return;
  }
  const streets = (await file.text())
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!streets.length || streets.length > 2000) {
    operationError.value = '文件需要包含 1 至 2000 行街道地址';
    return;
  }
  fileName.value = file.name;
  pendingStreets.value = streets;
}
async function importAddresses() {
  if (importing.value) return;
  if (!pendingStreets.value.length) {
    operationError.value = '请先选择包含街道地址的 TXT 文件';
    return;
  }
  importing.value = true;
  operationError.value = '';
  operationMessage.value = '';
  try {
    const result = await rechargeApi.importAddresses(pendingStreets.value);
    operationMessage.value = `成功导入 ${result.imported} 条，重复 ${result.duplicated} 条，未通过 ${result.rejected} 条。`;
    pendingStreets.value = [];
    fileName.value = '';
    page.value = 1;
    await query.refresh();
  } catch (cause) {
    operationError.value = getApiErrorMessage(cause);
  } finally {
    importing.value = false;
  }
}
function openStatusDialog(address: V2RechargeAddress, nextStatus: V2RechargeAddressStatus) {
  pendingAddress.value = address;
  pendingStatus.value = nextStatus;
  statusDialogOpen.value = true;
}
async function confirmStatusUpdate() {
  if (!pendingAddress.value || updating.value) return;
  updating.value = true;
  operationError.value = '';
  try {
    await rechargeApi.updateAddressStatus(pendingAddress.value.id, pendingStatus.value);
    statusDialogOpen.value = false;
    operationMessage.value = '地址状态已更新。';
    await query.refresh();
  } catch (cause) {
    operationError.value = getApiErrorMessage(cause);
  } finally {
    updating.value = false;
  }
}
</script>
