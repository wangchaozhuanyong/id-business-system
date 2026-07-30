<template>
  <section class="v2-records-page">
    <V2StatusStrip
      :items="activationStatusStripItems"
      :active-key="query.dueStatus"
      aria-label="当前页开通到期分布"
      @select="selectDueStatus"
    />

    <section class="v2-records-toolbar v2-activations-toolbar" aria-label="开通记录筛选">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="订单、客户、业务、ID账号"
        aria-label="搜索开通记录"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select
        v-model="query.dueStatus"
        clearable
        placeholder="全部到期状态"
        aria-label="筛选到期状态"
        @change="handleFilterChange"
      >
        <el-option
          v-for="option in dueStatusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <V2FilterDisclosure>
        <el-date-picker
          v-model="dueRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="到期开始"
          end-placeholder="到期结束"
          aria-label="筛选到期日期"
          @change="handleFilterChange"
        />
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="loading" @click="loadActivations">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2AsyncRegion
      skeleton="table"
      :loading="loading || isInitialLoading"
      :resolved="hasLoadedOnce"
      :error="listError"
      loading-title="正在加载开通记录"
      refreshing-title="正在更新开通记录"
      error-title="开通记录加载失败"
      @retry="loadActivations"
    >
      <section class="v2-records-list">
        <el-table
          :aria-busy="loading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table"
          :data="items"
          row-key="id"
          @sort-change="handleSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无开通记录</strong>
              <span>只有完成扣款并确认开通的订单才会出现在这里</span>
            </div>
          </template>

          <V2TableColumn kind="identifier" width-preset="identifier" label="订单" fixed="left">
            <template #default="{ row }">
              <strong class="v2-activation-order">{{ row.order.orderNo }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="客户" min-width="140">
            <template #default="{ row }">{{ row.customer.name }}</template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="业务" min-width="155">
            <template #default="{ row }">{{ row.service.name }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="identifier" label="苹果 ID">
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="wide" label="客户网站账号">
            <template #default="{ row }">{{ row.maskedWebsiteAccount || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="date"
            width-preset="dateTime"
            prop="openedAt"
            label="开通日期"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.openedAt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="date"
            width-preset="dateTime"
            prop="dueAt"
            label="到期日期"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.dueAt) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="status" width-preset="compact" prop="status" label="状态">
            <template #default="{ row }">
              <el-tag :type="statusType(row.status.code)" effect="plain">
                {{ row.status.label }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableActionColumn layout="single">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="openDetail(row)">
                <el-icon><View /></el-icon>
                详情
              </AppButton>
            </template>
          </V2TableActionColumn>
        </el-table>

        <div class="v2-records-mobile-list">
          <article v-for="item in items" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.order.orderNo }}</strong>
                <span>{{ item.customer.name }} / {{ item.service.name }}</span>
              </div>
              <el-tag :type="statusType(item.status.code)" effect="plain">
                {{ item.status.label }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>苹果 ID</dt>
                <dd>{{ item.account.appleIdMasked }}</dd>
              </div>
              <div>
                <dt>客户网站账号</dt>
                <dd>{{ item.maskedWebsiteAccount || '—' }}</dd>
              </div>
              <div>
                <dt>开通日期</dt>
                <dd>{{ formatDate(item.openedAt) }}</dd>
              </div>
              <div>
                <dt>到期日期</dt>
                <dd>{{ formatDate(item.dueAt) }}</dd>
              </div>
            </dl>
            <footer>
              <span />
              <AppButton size="small" variant="ghost" @click="openDetail(item)">
                <el-icon><View /></el-icon>
                详情
              </AppButton>
            </footer>
          </article>
          <div v-if="!items.length" class="v2-records-empty">
            <strong>暂无开通记录</strong>
            <span>当前筛选条件下没有数据</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ total }} 条</span>
          <el-pagination
            v-model:current-page="query.page"
            v-model:page-size="query.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="total"
            @current-change="handlePageChange"
            @size-change="handlePageSizeChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>

    <el-drawer v-model="detailVisible" title="开通记录详情" size="min(620px, 94vw)">
      <V2AsyncRegion
        variant="section"
        skeleton="detail"
        :loading="detailLoading"
        :resolved="Boolean(detail)"
        :error="detailError"
        loading-title="正在加载开通记录"
        refreshing-title="正在更新开通记录"
        error-title="开通记录加载失败"
        @retry="retryDetail"
      >
        <div v-if="detail" class="v2-activation-detail">
          <dl>
            <div>
              <dt>订单</dt>
              <dd>{{ detail.order.orderNo }}</dd>
            </div>
            <div>
              <dt>客户</dt>
              <dd>{{ detail.customer.name }}</dd>
            </div>
            <div>
              <dt>业务</dt>
              <dd>{{ detail.service.name }}</dd>
            </div>
            <div>
              <dt>苹果 ID</dt>
              <dd>{{ detail.account.appleIdMasked }}</dd>
            </div>
            <div>
              <dt>国家</dt>
              <dd>{{ detail.account.country.name }}</dd>
            </div>
            <div>
              <dt>网站账号</dt>
              <dd>{{ detail.maskedWebsiteAccount || '—' }}</dd>
            </div>
            <div>
              <dt>开通日期</dt>
              <dd>{{ formatDate(detail.openedAt) }}</dd>
            </div>
            <div>
              <dt>到期日期</dt>
              <dd>{{ formatDate(detail.dueAt) }}</dd>
            </div>
            <div>
              <dt>到期状态</dt>
              <dd>{{ detail.status.label }}</dd>
            </div>
            <div>
              <dt>订单利润</dt>
              <dd>{{ formatNullableDecimal(detail.order.profitAmount) }}</dd>
            </div>
            <div>
              <dt>备注</dt>
              <dd>{{ detail.remark || '—' }}</dd>
            </div>
            <div>
              <dt>记录生成时间</dt>
              <dd>{{ formatDate(detail.createdAt) }}</dd>
            </div>
          </dl>
        </div>
      </V2AsyncRegion>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { computed, reactive, ref } from 'vue';
import { Refresh, Search, View } from '@element-plus/icons-vue';
import type { TagProps } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import { idBusinessV2ActivationsApi } from './api';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2StatusStrip, { type V2StatusStripItem } from '@/v2/components/V2StatusStrip.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import type {
  V2Activation,
  V2ActivationDueStatus,
  V2ActivationListQuery,
  V2ActivationListResult
} from './contracts';
import '@/v2/styles/records.css';
import '@/v2/styles/activations.css';

const dueStatusOptions: Array<{ value: V2ActivationDueStatus; label: string }> = [
  { value: 'due_within_1_hour', label: '1小时内到期' },
  { value: 'due_within_23_hours', label: '23小时内到期' },
  { value: 'due_within_7_days', label: '7天内到期' },
  { value: 'expired', label: '已到期' },
  { value: 'active', label: '正常' },
  { value: 'abnormal', label: '异常' },
  { value: 'cancelled', label: '已取消' }
];

const dueRange = ref<[string, string] | []>([]);
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailError = ref('');
const detail = ref<V2Activation | null>(null);
const detailTarget = ref<V2Activation | null>(null);
const query = reactive({
  page: 1,
  pageSize: 20,
  keyword: '',
  dueStatus: '' as V2ActivationDueStatus | '',
  sortBy: 'dueAt' as NonNullable<V2ActivationListQuery['sortBy']>,
  sortOrder: 'asc' as 'asc' | 'desc'
});
function getActivationListQuery(): V2ActivationListQuery {
  return {
    ...query,
    keyword: query.keyword.trim() || undefined,
    dueStatus: query.dueStatus || undefined,
    dueFrom: dueRange.value[0] || undefined,
    dueTo: dueRange.value[1] || undefined
  };
}
const activationQuery = useV2ModuleQuery<V2ActivationListResult>({
  moduleKey: 'activation-records',
  scope: 'activations',
  key: () => createV2QueryKey(getActivationListQuery()),
  keepPreviousData: true,
  getRevalidateAt: (result) => result.revalidateAt,
  query: ({ signal }) => idBusinessV2ActivationsApi.list(getActivationListQuery(), { signal })
});
const items = computed(() => activationQuery.data.value?.items ?? []);
const total = computed(() => activationQuery.data.value?.total ?? 0);
const loading = computed(
  () => activationQuery.isInitialLoading.value || activationQuery.isRefreshing.value
);
const listError = computed(() =>
  activationQuery.error.value ? getApiErrorMessage(activationQuery.error.value) : ''
);
const { hasLoadedOnce, isInitialLoading } = activationQuery;
const activationStatusStripItems = computed<V2StatusStripItem[]>(() => {
  const visibleStatuses: V2ActivationDueStatus[] = [
    'due_within_1_hour',
    'due_within_23_hours',
    'due_within_7_days',
    'expired',
    'active'
  ];
  const tones: Partial<Record<V2ActivationDueStatus, V2StatusStripItem['tone']>> = {
    due_within_1_hour: 'danger',
    due_within_23_hours: 'warning',
    due_within_7_days: 'primary',
    expired: 'danger',
    active: 'success'
  };
  return visibleStatuses.map((status) => ({
    key: status,
    label:
      status === 'expired' || status === 'active'
        ? (dueStatusOptions.find((option) => option.value === status)?.label ?? status)
        : (dueStatusOptions.find((option) => option.value === status)?.label ?? status).replace(
            '到期',
            ''
          ),
    count: items.value.filter((item) => item.status.code === status).length,
    tone: tones[status]
  }));
});

async function loadActivations() {
  await activationQuery.refresh();
}

function loadCurrentActivations() {
  void activationQuery.ensureFresh();
}

function handleSearch() {
  query.page = 1;
  loadCurrentActivations();
}

function handleFilterChange() {
  query.page = 1;
  loadCurrentActivations();
}

function selectDueStatus(key: string) {
  const dueStatus = key as V2ActivationDueStatus;
  query.dueStatus = query.dueStatus === dueStatus ? '' : dueStatus;
  handleFilterChange();
}

function handlePageSizeChange() {
  query.page = 1;
  loadCurrentActivations();
}

function handlePageChange() {
  loadCurrentActivations();
}

function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
  const supported: Array<NonNullable<V2ActivationListQuery['sortBy']>> = [
    'openedAt',
    'dueAt',
    'status',
    'createdAt',
    'updatedAt'
  ];
  query.sortBy = supported.includes(sort.prop as NonNullable<V2ActivationListQuery['sortBy']>)
    ? (sort.prop as NonNullable<V2ActivationListQuery['sortBy']>)
    : 'dueAt';
  query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
  query.page = 1;
  loadCurrentActivations();
}

async function openDetail(item: V2Activation) {
  detailTarget.value = item;
  detailVisible.value = true;
  detailLoading.value = true;
  detailError.value = '';
  detail.value = null;
  try {
    detail.value = await idBusinessV2ActivationsApi.get(item.id);
  } catch (error) {
    detailError.value = getApiErrorMessage(error);
  } finally {
    detailLoading.value = false;
  }
}

function retryDetail() {
  if (detailTarget.value) void openDetail(detailTarget.value);
}

function statusType(status: V2ActivationDueStatus): TagProps['type'] {
  if (status === 'active') return 'success';
  if (status === 'due_within_7_days') return 'primary';
  if (status === 'due_within_23_hours' || status === 'due_within_1_hour') return 'warning';
  if (status === 'expired' || status === 'abnormal') return 'danger';
  return 'info';
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function formatNullableDecimal(value: string | null) {
  if (value === null) return '—';
  const [integer, fraction = ''] = value.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}
</script>
