<template>
  <section class="v2-page-layout v2-records-page">
    <V2PageContext
      description="统一管理比特充值与线上代充使用的代理，支持代理地址、动态会话和提取链接。"
    >
      <template #filters
        ><ProxyPoolFilters v-model="filters" @search="filters.page = 1"
      /></template>
      <template #actions>
        <AppButton v-if="canManage" @click="importOpen = true">批量导入</AppButton>
        <AppButton v-if="canManage" @click="test()">检测启用代理</AppButton>
        <AppButton v-if="canManage" variant="primary" @click="edit(null)">新增代理</AppButton>
        <AppButton variant="ghost" allow-when-stale @click="query.refresh">刷新</AppButton>
      </template>
    </V2PageContext>
    <p v-if="feedback" :role="failed ? 'alert' : 'status'">{{ feedback }}</p>
    <V2AsyncRegion
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="table"
      loading-title="正在加载共用代理池"
      @retry="query.refresh"
    >
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading title="代理 IP 管理"
            ><template #actions
              ><span>共 {{ query.data.value?.total ?? 0 }} 条</span></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="v2TableSchemas.rechargeProxies.main"
          :view-key="query.requestedKey.value"
          :data="query.data.value?.items ?? []"
          class="v2-records-table"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无代理</strong><span>新增或批量导入后，两套充值均可使用</span>
            </div></template
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[0]"
            ><template #default="{ row }">{{ cell(row, 'displayHost') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[1]"
            ><template #default="{ row }">{{ cell(row, 'protocol') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[2]"
            ><template #default="{ row }">{{
              cell(row, 'connectionMode')
            }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[3]"
            ><template #default="{ row }">{{ cell(row, 'kind') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[4]"
            ><template #default="{ row }">{{ cell(row, 'countryCode') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[5]"
            ><template #default="{ row }">{{ cell(row, 'remark') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[6]"
            ><template #default="{ row }">{{ cell(row, 'status') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[7]"
            ><template #default="{ row }">{{ cell(row, 'exitIp') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[8]"
            ><template #default="{ row }">{{ cell(row, 'latencyMs') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[9]"
            ><template #default="{ row }">{{ cell(row, 'testMessage') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[10]"
            ><template #default="{ row }">{{ cell(row, 'testedAt') }}</template></V2TableColumn
          >
          <V2TableColumn :definition="v2TableSchemas.rechargeProxies.main.columns[11]"
            ><template #default="{ row }">{{ cell(row, 'updatedAt') }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="v2TableSchemas.rechargeProxies.main.columns[12]"
            ><template #default="{ row }">
              <AppButton v-if="canReveal" size="small" variant="ghost" @click="detailId = row.id"
                >详细</AppButton
              >
              <el-dropdown
                v-if="canManage"
                trigger="click"
                @command="(key: string) => action(key, row)"
                ><AppButton size="small" variant="ghost" :disabled="busy">更多操作</AppButton
                ><template #dropdown
                  ><el-dropdown-menu>
                    <el-dropdown-item command="edit">编辑</el-dropdown-item
                    ><el-dropdown-item command="test">检测连通性</el-dropdown-item
                    ><el-dropdown-item command="status">{{
                      row.status === 'active' ? '停用' : '启用'
                    }}</el-dropdown-item
                    ><el-dropdown-item command="delete">删除</el-dropdown-item>
                  </el-dropdown-menu></template
                ></el-dropdown
              >
            </template></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 条</span
          ><el-pagination
            v-pagination-label
            :current-page="
              query.data.value?.total === 0 ? 1 : (query.data.value?.page ?? filters.page)
            "
            :page-size="query.data.value?.pageSize ?? filters.pageSize"
            :total="query.data.value?.total ?? 0"
            :page-sizes="[20, 50, 100]"
            layout="sizes, prev, pager, next"
            background
            @current-change="filters.page = $event"
            @size-change="
              filters.pageSize = $event;
              filters.page = 1;
            "
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <ProxyPoolEditor v-if="editorOpen" v-model="editorOpen" :row="editing" @saved="query.refresh" />
    <ProxyPoolImport v-if="importOpen" v-model="importOpen" @saved="query.refresh" />
    <V2RechargeProxyDetailDrawer v-if="detailId" :id="detailId" @close="detailId = ''" />
    <V2ConfirmDialog
      v-model="deleteOpen"
      title="删除代理"
      message="已用于充值或关联任务的代理不能删除，请改为停用。"
      danger
      :confirm-loading="busy"
      @confirm="remove"
      ><p v-if="failed" role="alert">{{ feedback }}</p></V2ConfirmDialog
    >
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery, createV2QueryKey } from '@/v2/composables/useV2Query';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { proxyPoolApi } from './api';
import type { ProxyPoolItem } from './contracts';
import { proxyCountryLabel, proxyKindLabel, proxyProtocolLabel } from './options';
import ProxyPoolEditor from './ProxyPoolEditor.vue';
import ProxyPoolImport from './ProxyPoolImport.vue';
import ProxyPoolFilters from './ProxyPoolFilters.vue';
import V2RechargeProxyDetailDrawer from './V2RechargeProxyDetailDrawer.vue';
import '@/v2/styles/records.css';
const auth = useAuthStore();
const canManage = computed(() =>
  hasUserPermission(auth.user, 'id_business_v2.online_recharge.manage')
);
const canReveal = computed(
  () =>
    hasUserPermission(auth.user, 'id_business_v2.online_recharge.sensitive') &&
    (auth.user?.roles.includes('admin') ||
      !(
        auth.user as { sensitiveApprovalPermissionCodes?: readonly string[] } | null
      )?.sensitiveApprovalPermissionCodes?.includes('id_business_v2.online_recharge.sensitive'))
);
const filters = useV2SessionDraft('proxy-pool/filters', () =>
  ref({
    page: 1,
    pageSize: 20,
    keyword: '',
    countryCode: '',
    kind: '',
    status: '',
    sortOrder: 'desc'
  })
);
const query = useV2ModuleQuery({
  moduleKey: 'recharge-proxies',
  scope: 'online-recharge',
  key: () => createV2QueryKey(filters.value),
  keepPreviousData: true,
  query: ({ signal }) => proxyPoolApi.list(filters.value, { signal })
});
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => query.data.value?.items ?? [],
  pageSize: () => filters.value.pageSize
});
const editorOpen = ref(false),
  importOpen = ref(false),
  deleteOpen = ref(false),
  busy = ref(false),
  failed = ref(false);
const editing = ref<ProxyPoolItem | null>(null),
  deleting = ref<ProxyPoolItem | null>(null),
  detailId = ref(''),
  feedback = ref('');
function cell(row: ProxyPoolItem, key: string) {
  if (key === 'countryCode') return proxyCountryLabel(row.countryCode);
  if (key === 'kind') return proxyKindLabel(row.kind);
  if (key === 'protocol') return proxyProtocolLabel(row.protocol);
  if (key === 'connectionMode')
    return row.connectionMode === 'extraction' ? '提取链接' : '代理地址';
  if (key === 'status') return row.status === 'active' ? '启用' : '停用';
  if (key === 'testedAt' || key === 'updatedAt')
    return row[key] ? formatV2DateTime(row[key]!) : '尚未检测';
  if (key === 'displayHost') return row.displayHost || row.linkMask;
  return row[key as keyof ProxyPoolItem] ?? '—';
}
function edit(row: ProxyPoolItem | null) {
  editing.value = row;
  editorOpen.value = true;
}
async function test(id?: string) {
  if (busy.value) return;
  busy.value = true;
  failed.value = false;
  feedback.value = '';
  try {
    const result = await proxyPoolApi.test(id);
    feedback.value = result.tasks.length
      ? `已排队 ${result.tasks.length} 个检测任务，请稍后刷新查看结果`
      : '暂无启用代理可检测';
  } catch (cause) {
    failed.value = true;
    feedback.value = getApiErrorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function action(key: string, row: ProxyPoolItem) {
  if (key === 'edit') return edit(row);
  if (key === 'test') return test(row.id);
  if (key === 'delete') {
    deleting.value = row;
    deleteOpen.value = true;
    failed.value = false;
    return;
  }
  if (busy.value) return;
  busy.value = true;
  failed.value = false;
  try {
    await proxyPoolApi.update(row.id, {
      status: row.status === 'active' ? 'disabled' : 'active',
      expectedUpdatedAt: row.updatedAt
    });
    await query.refresh();
  } catch (cause) {
    failed.value = true;
    feedback.value = getApiErrorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!deleting.value || busy.value) return;
  busy.value = true;
  failed.value = false;
  try {
    await proxyPoolApi.delete(deleting.value.id);
    deleteOpen.value = false;
    await query.refresh();
  } catch (cause) {
    failed.value = true;
    feedback.value = getApiErrorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
