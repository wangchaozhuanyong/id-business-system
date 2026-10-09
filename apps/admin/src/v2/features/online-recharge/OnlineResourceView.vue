<template>
  <section v-if="canRead" class="v2-page-layout v2-records-page online-page">
    <V2PageContext :description="sectionDescriptions[section]">
      <template #filters
        ><div class="online-filters">
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="搜索当前清单"
            aria-label="搜索当前清单"
            @keyup.enter="search"
          /><el-select v-if="statusOptions.length" v-model="filters.status" aria-label="状态"
            ><el-option label="全部状态" value="" /><el-option
              v-for="item in statusOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value" /></el-select
          ><el-select v-if="hasPlan" v-model="filters.plan" aria-label="套餐"
            ><el-option label="全部套餐" value="" /><el-option
              v-for="item in planOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value" /></el-select
          ><el-select v-if="section === 'cdks'" v-model="filters.dispatched" aria-label="出库状态"
            ><el-option label="全部出库状态" value="" /><el-option
              label="未出库"
              value="false" /><el-option label="已出库" value="true"
          /></el-select>
          <el-select v-model="filters.sortOrder" aria-label="排序"
            ><el-option label="时间从新到旧" value="desc" /><el-option
              label="时间从旧到新"
              value="asc"
          /></el-select>
          <el-select v-if="section === 'addresses'" v-model="filters.region" aria-label="地址池地区"
            ><el-option
              v-for="item in addressPoolOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value" /></el-select
          ><el-date-picker
            v-if="section === 'billing'"
            v-model="dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            aria-label="账单日期范围"
          /><AppButton variant="soft" @click="search">查询</AppButton>
        </div></template
      >
      <template #actions
        ><AppButton
          v-for="action in visibleTopActions"
          :key="action.key"
          :variant="action.danger ? 'danger' : 'primary'"
          @click="openAction(action)"
          >{{ action.label }}</AppButton
        ><AppButton variant="ghost" allow-when-stale @click="query.refresh"
          >刷新</AppButton
        ></template
      >
    </V2PageContext>
    <p v-if="requiresOnlineSensitiveApproval(authStore.user)">
      敏感资料查看需要审批，当前页面暂不提供直接取密。
    </p>
    <p
      v-if="feedback"
      :role="feedbackError ? 'alert' : 'status'"
      :class="{ 'online-error': feedbackError }"
    >
      {{ feedback }}
    </p>
    <V2AsyncRegion
      :phase="query.phase.value"
      :previous-data="query.isParameterTransition.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="table"
      :loading-title="`正在加载${sectionTitles[section]}`"
      @retry="query.refresh"
    >
      <section v-if="section === 'browser-pool'" class="online-panel">
        <V2SectionHeading title="浏览器运行观测" />
        <dl class="online-status-grid">
          <dt>已配置模式</dt>
          <dd>{{ onlineLabel(query.data.value?.config?.browserMode) }}</dd>
          <dt>已配置槽位</dt>
          <dd>{{ query.data.value?.config?.browserPoolSize ?? '未获取' }}</dd>
          <dt>运行观测</dt>
          <dd>
            {{
              query.data.value?.observedAt
                ? onlineCell(
                    { id: '', observedAt: query.data.value.observedAt },
                    'observedAt',
                    'date'
                  )
                : '尚未检测'
            }}
          </dd>
          <dt>观测槽位总数</dt>
          <dd>{{ query.data.value?.runtime?.size ?? '未获取' }}</dd>
          <dt>观测空闲槽位</dt>
          <dd>{{ query.data.value?.runtime?.idle ?? '未获取' }}</dd>
          <dt>观测占用槽位</dt>
          <dd>{{ query.data.value?.runtime?.busy ?? '未获取' }}</dd>
        </dl>
        <p v-if="!query.data.value?.observedAt">执行检测浏览器后显示实际运行状态。</p>
      </section>
      <section ref="listRef" class="v2-records-list" :style="listFrameStyle">
        <header>
          <V2SectionHeading :title="sectionTitles[section]"
            ><template #actions
              ><span>共 {{ query.data.value?.total ?? 0 }} 条</span></template
            ></V2SectionHeading
          >
        </header>
        <V2Table
          :schema="schema"
          :view-key="query.requestedKey.value"
          :data="query.data.value?.items ?? []"
          class="v2-records-table"
          @selection-change="selectRows"
        >
          <template #empty
            ><div class="v2-records-empty">
              <strong>暂无记录</strong><span>调整查询条件或添加资料后刷新</span>
            </div></template
          >
          <V2TableControlColumn v-if="controlColumn" :definition="controlColumn" />
          <V2TableColumn
            v-for="column in dataColumns"
            :key="column.key"
            :definition="column"
            :prop="column.key"
            ><template #default="{ row }">{{
              onlineCell(row, column.fieldName, column.kind)
            }}</template></V2TableColumn
          >
          <V2TableActionColumn :definition="actionColumn"
            ><template #default="{ row }"
              ><AppButton
                v-if="primaryAction && allowedForRow(primaryAction, row)"
                size="small"
                variant="ghost"
                @click="openAction(primaryAction, row)"
                >{{ primaryAction.label }}</AppButton
              ><el-dropdown
                v-if="remainingForRow(row).length"
                trigger="click"
                @command="(key: string) => chooseRowAction(key, row)"
                ><AppButton size="small" variant="ghost">更多操作</AppButton
                ><template #dropdown
                  ><el-dropdown-menu
                    ><el-dropdown-item
                      v-for="action in remainingForRow(row)"
                      :key="action.key"
                      :command="action.key"
                      >{{ action.label }}</el-dropdown-item
                    ></el-dropdown-menu
                  ></template
                ></el-dropdown
              ></template
            ></V2TableActionColumn
          >
        </V2Table>
        <footer class="v2-records-pagination">
          <span>共 {{ query.data.value?.total ?? 0 }} 条</span
          ><el-pagination
            v-pagination-label
            :current-page="displayedPage"
            :page-size="displayedPageSize"
            :total="query.data.value?.total ?? 0"
            :page-sizes="[20, 50, 100]"
            layout="sizes, prev, pager, next"
            background
            @current-change="changePage"
            @size-change="changePageSize"
          />
        </footer>
      </section>
    </V2AsyncRegion>
    <OnlineActionDrawer
      v-if="selectedAction"
      v-model="drawerOpen"
      :section="section"
      :action="selectedAction"
      :row="selectedRow"
      @saved="onSaved"
    />
    <V2ConfirmDialog
      v-model="confirmOpen"
      :title="selectedAction?.label ?? '确认操作'"
      :message="selectedAction?.confirm ?? ''"
      :danger="selectedAction?.danger"
      :confirm-loading="busy"
      @confirm="runAction"
    />
    <OnlineResultDialog v-model="resultOpen" :result="result" @copied="markCopied" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import {
  isV2TableDataColumn,
  type V2TableControlColumnDefinition,
  type V2TableActionColumnDefinition
} from '@/v2/components/tableSystem';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { useAuthStore } from '@/stores/auth';
import { canUseOnlineAction, requiresOnlineSensitiveApproval } from './permissions';
import type { V2ModuleKey } from '@/v2/features/feature';
import OnlineActionDrawer from './OnlineActionDrawer.vue';
import OnlineResultDialog from './OnlineResultDialog.vue';
import { onlineApi, downloadOnlineText, copyOnlineText } from './api';
import {
  onlineCell,
  onlineError,
  onlineLabel,
  onlineStatusOptions,
  planOptions,
  addressPoolOptions
} from './labels';
import {
  topActions,
  rowActions,
  sectionDescriptions,
  sectionTitles,
  onlineActionAllowedForRow
} from './sections';
import { onlineTableSchemas } from './tableSchemas';
import type { OnlineAction, OnlineQuery, OnlineRow, OnlineSection } from './contracts';
import '@/v2/styles/records.css';
import './online-recharge.css';
const props = defineProps<{ descriptor: { section: OnlineSection; moduleKey: V2ModuleKey } }>();
const section = props.descriptor.section;
const filters = useV2SessionDraft(`online-recharge/${section}/filters`, () =>
  ref<OnlineQuery>({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: '',
    plan: '',
    region: 'US',
    dispatched: '',
    sortOrder: 'desc'
  })
);
const dateRange = useV2SessionDraft(`online-recharge/${section}/dateRange`, () =>
  ref<[string, string] | null>(null)
);
const hasPlan = computed(() =>
  ['cdks', 'jobs', 'sessions', 'renewal', 'billing'].includes(section)
);
const statusOptions = computed(() => onlineStatusOptions(section));
const authStore = useAuthStore();
const canRead = computed(() => canUseOnlineAction(authStore.user, section, 'detail'));
const query = useV2ModuleQuery({
  moduleKey: props.descriptor.moduleKey,
  scope: 'online-recharge',
  enabled: () => canUseOnlineAction(authStore.user, section, 'detail'),
  key: () =>
    createV2QueryKey({
      section: section,
      ...filters.value,
      startDate: dateRange.value?.[0],
      endDate: dateRange.value?.[1]
    }),
  keepPreviousData: true,
  query: ({ signal }) =>
    onlineApi.list(
      section,
      { ...filters.value, startDate: dateRange.value?.[0], endDate: dateRange.value?.[1] },
      signal
    )
});
const displayedPage = computed(() =>
  query.data.value?.total === 0 ? 1 : (query.data.value?.page ?? filters.value.page)
);
const displayedPageSize = computed(() => query.data.value?.pageSize ?? filters.value.pageSize);
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => query.data.value?.items ?? [],
  pageSize: () => filters.value.pageSize
});
const schema = computed(() => onlineTableSchemas[section]);
const dataColumns = computed(() =>
  schema.value.columns
    .filter(isV2TableDataColumn)
    .map((column) => ({ ...column, fieldName: column.key }))
);
// prettier-ignore
const actionColumn = computed(() => schema.value.columns.find(column => column.kind === 'actions') as V2TableActionColumnDefinition);
const controlColumn = computed(
  () =>
    schema.value.columns.find((column) => column.kind === 'control') as
      | V2TableControlColumnDefinition
      | undefined
);
const selectedIds = ref<string[]>([]);
function selectRows(rows: OnlineRow[]) {
  selectedIds.value = rows.map((row) => row.id);
}
const visibleTopActions = computed(() =>
  (topActions[section] ?? []).filter((action) =>
    canUseOnlineAction(authStore.user, section, action.key)
  )
);
const actions = computed(() =>
  (rowActions[section] ?? []).filter((action) =>
    canUseOnlineAction(authStore.user, section, action.key)
  )
);
const primaryAction = computed(() => actions.value[0]);
const remainingActions = computed(() => actions.value.slice(1));
const selectedAction = ref<OnlineAction>();
const selectedRow = ref<OnlineRow>();
const drawerOpen = ref(false);
const confirmOpen = ref(false);
const busy = ref(false);
const resultOpen = ref(false);
const result = ref<Record<string, unknown>>({});
const feedback = ref('');
const feedbackError = ref(false);
watch(resultOpen, (open) => {
  if (!open) result.value = {};
});
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(() => {
  drawerOpen.value = false;
  confirmOpen.value = false;
  resultOpen.value = false;
  result.value = {};
  feedback.value = '';
});
onBeforeUnmount(stopIdentityWatch);
function changePage(value: number) {
  if (query.data.value?.total === 0 || !query.hasCurrentData.value) return;
  filters.value.page = value;
}
function changePageSize(value: number) {
  filters.value.pageSize = value;
  filters.value.page = 1;
}
function search() {
  filters.value.page = 1;
  void query.refresh();
}
function chooseRowAction(key: string, row: OnlineRow) {
  const action = actions.value.find((item) => item.key === key);
  if (action) openAction(action, row);
}
function allowedForRow(action: OnlineAction, row: OnlineRow) {
  return onlineActionAllowedForRow(section, action, row);
}
function remainingForRow(row: OnlineRow) {
  return remainingActions.value.filter((action) => allowedForRow(action, row));
}
function openAction(action: OnlineAction, row?: OnlineRow) {
  selectedAction.value = action;
  selectedRow.value = row;
  feedback.value = '';
  if (action.key === 'detail' && ['runtime-logs', 'login-logs'].includes(section) && row) {
    result.value = { ...row };
    resultOpen.value = true;
    return;
  }
  if (action.fields?.length) drawerOpen.value = true;
  else if (action.confirm) confirmOpen.value = true;
  else void runAction();
}
async function markCopied() {
  if (section !== 'cdks') return;
  try {
    await onlineApi.action('cdks', 'dispatch', {
      ids: Array.isArray(result.value.ids)
        ? result.value.ids
        : selectedRow.value
          ? [selectedRow.value.id]
          : selectedIds.value
    });
    feedback.value = '已复制并标记出库';
    await query.refresh();
  } catch (cause) {
    feedbackError.value = true;
    feedback.value = onlineError(cause);
  }
}
async function onSaved(value: Record<string, unknown>) {
  if (selectedAction.value?.key === 'export') {
    const content = String(value.content ?? value.csv ?? value.text ?? '');
    if (!content) throw new Error('导出没有返回文件内容');
    downloadOnlineText(
      content,
      String(value.filename ?? `${sectionTitles[section]}.csv`),
      'text/csv;charset=utf-8'
    );
  }
  feedbackError.value = false;
  feedback.value =
    selectedAction.value?.key === 'recheck'
      ? '原单核对任务已提交，请刷新核对结果；不会再次付款。'
      : String(value.message ?? '操作完成');
  if (
    ['detail', 'reveal', 'summary', 'artifacts', 'subscription', 'generate'].includes(
      selectedAction.value?.key ?? ''
    ) ||
    value.id ||
    value.tasks
  ) {
    result.value = value;
    resultOpen.value = true;
  }
  await query.refresh();
}
async function runAction() {
  if (!selectedAction.value || busy.value) return;
  busy.value = true;
  feedback.value = '';
  try {
    if (['batch-delete', 'copy'].includes(selectedAction.value.key) && !selectedIds.value.length)
      throw new Error('请先选中需要操作的兑换码');
    const value = await onlineApi.action(
      section,
      selectedAction.value.key === 'batch-delete'
        ? 'delete'
        : selectedAction.value.key === 'copy'
          ? 'export'
          : selectedAction.value.key,
      selectedAction.value.key === 'recheck'
        ? { id: selectedRow.value?.id }
        : {
            ...filters.value,
            id: selectedRow.value?.id,
            ids: selectedRow.value
              ? undefined
              : selectedIds.value.length
                ? selectedIds.value
                : query.data.value?.items.map((item) => item.id),
            cardLast4: selectedRow.value?.cardLast4,
            startDate: dateRange.value?.[0],
            endDate: dateRange.value?.[1]
          }
    );
    confirmOpen.value = false;
    if (selectedAction.value.key === 'copy') {
      await copyOnlineText(String(value.content ?? ''));
      await onlineApi.action(section, 'dispatch', { ids: selectedIds.value });
      feedback.value = '已复制并出库';
      await query.refresh();
      return;
    }
    await onSaved(value);
  } catch (cause) {
    feedbackError.value = true;
    feedback.value = onlineError(cause);
  } finally {
    busy.value = false;
  }
}
</script>
