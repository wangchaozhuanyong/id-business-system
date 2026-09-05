<template>
  <section class="v2-visits" aria-label="装修网站访问记录">
    <header><strong>访问记录与访客 IP</strong><small>装修网站 · flashcast.com.my</small></header>
    <p v-if="!isAdmin" role="note">访问记录仅管理员可查看。</p>
    <template v-else>
      <div class="v2-visits__toolbar">
        <el-radio-group
          v-model="days"
          size="small"
          aria-label="访问记录日期范围"
          @change="applySearch"
        >
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
        </el-radio-group>
        <AppButton
          size="small"
          variant="ghost"
          :disabled="query.isRefreshing.value"
          @click="refresh"
          >刷新记录</AppButton
        >
      </div>
      <el-form
        label-position="left"
        label-width="60px"
        require-asterisk-position="right"
        @submit.prevent="applySearch"
      >
        <el-form-item label="访客 IP">
          <div class="v2-visits__search">
            <el-input
              v-model="ipFilter"
              maxlength="45"
              placeholder="输入完整 IP 精确查询"
              clearable
              aria-label="访客 IP 精确查询"
            />
            <AppButton type="submit" size="small" :disabled="query.isRefreshing.value"
              >查询</AppButton
            >
          </div>
        </el-form-item>
      </el-form>
      <V2AsyncRegion
        :phase="query.phase.value"
        :previous-data="query.isPlaceholderData.value"
        :error="queryError"
        :empty="false"
        variant="section"
        skeleton="form"
        loading-title="正在读取访问记录"
        refreshing-title="正在更新访问记录"
        error-title="访问记录读取失败"
        @retry="query.refresh"
      >
        <template v-if="report">
          <p class="v2-visits__context">
            近 {{ report.days }} 天（含今天） · UTC+08:00 · 更新于
            {{ formatV2DateTime(report.fetchedAt) }}
          </p>
          <dl class="v2-visits__metrics">
            <div>
              <dt>已采集浏览量</dt>
              <dd>{{ count(report.summary?.pageViews) }}</dd>
            </div>
            <div>
              <dt>独立 IP 数</dt>
              <dd>{{ count(report.summary?.uniqueIps) }}</dd>
            </div>
          </dl>
          <p v-if="report.status === 'not_configured'" class="v2-visits__notice" role="status">
            尚未启用网站访问采集。未启用不代表访问量为零。
          </p>
          <p v-else-if="report.status === 'empty'" class="v2-visits__notice" role="status">
            当前范围或 IP 筛选暂无已采集记录。接入前的历史访问无法补回。
          </p>
          <p v-else class="v2-visits__notice">
            最近接收：{{ formatV2DateTime(report.lastReceivedAt) }}。计数随当前日期和 IP 筛选变化。
          </p>
          <div class="v2-visits__toolbar">
            <el-radio-group v-model="view" size="small" aria-label="访问记录展示方式">
              <el-radio-button value="daily">每日统计</el-radio-button>
              <el-radio-button value="records">IP 明细</el-radio-button>
            </el-radio-group>
            <el-select
              v-if="view === 'records'"
              v-model="sort"
              size="small"
              aria-label="访问时间排序"
              class="v2-visits__sort"
              @change="applySearch"
            >
              <el-option label="最新在前" value="newest" /><el-option
                label="最早在前"
                value="oldest"
              />
            </el-select>
          </div>
          <p v-if="revealError" role="alert" class="v2-visits__notice">{{ revealError }}</p>
          <div class="v2-visits__table-region">
            <V2Table
              v-if="view === 'daily'"
              :data="visibleDays"
              :schema="v2TableSchemas.workspace.websiteVisitDaily"
              :show-column-settings="false"
            >
              <V2TableColumn
                :definition="v2TableSchemas.workspace.websiteVisitDaily.columns[0]"
                prop="date"
              />
              <V2TableColumn :definition="v2TableSchemas.workspace.websiteVisitDaily.columns[1]"
                ><template #default="{ row }">{{
                  count(row.metrics?.pageViews)
                }}</template></V2TableColumn
              >
              <V2TableColumn :definition="v2TableSchemas.workspace.websiteVisitDaily.columns[2]"
                ><template #default="{ row }">{{
                  count(row.metrics?.uniqueIps)
                }}</template></V2TableColumn
              >
            </V2Table>
            <V2Table
              v-else
              :data="report.items"
              :schema="v2TableSchemas.workspace.websiteVisits"
              :show-column-settings="false"
              empty-text="暂无已采集访问记录"
            >
              <V2TableColumn :definition="v2TableSchemas.workspace.websiteVisits.columns[0]"
                ><template #default="{ row }">{{
                  formatV2DateTime(row.occurredAt)
                }}</template></V2TableColumn
              >
              <V2TableColumn
                :definition="v2TableSchemas.workspace.websiteVisits.columns[1]"
                prop="path"
              />
              <V2TableColumn :definition="v2TableSchemas.workspace.websiteVisits.columns[2]"
                ><template #default="{ row }"
                  ><span class="v2-visits__ip">{{
                    revealed[row.id] || row.ipMasked
                  }}</span></template
                ></V2TableColumn
              >
              <V2TableActionColumn :definition="v2TableSchemas.workspace.websiteVisits.columns[3]">
                <template #default="{ row }"
                  ><AppButton
                    size="small"
                    variant="ghost"
                    :disabled="pendingReveal === row.id"
                    @click="toggleIp(row.id)"
                    >{{
                      pendingReveal === row.id ? '读取中' : revealed[row.id] ? '隐藏 IP' : '查看 IP'
                    }}</AppButton
                  ></template
                >
              </V2TableActionColumn>
            </V2Table>
          </div>
          <el-pagination
            v-if="view === 'daily'"
            v-model:current-page="dailyPage"
            :page-size="7"
            :total="report.daily.length"
            layout="prev, pager, next"
            small
            aria-label="访问日报分页"
          />
          <el-pagination
            v-else
            :current-page="report.page"
            :page-size="report.pageSize"
            :total="report.total"
            layout="prev, pager, next"
            small
            aria-label="访客 IP 明细分页"
            @current-change="changePage"
          />
        </template>
      </V2AsyncRegion>
      <footer>
        在线记录保留 30 天，IP 默认脱敏，查看完整 IP 会留审计并在 30 秒后隐藏。独立 IP
        不等于访客或客户数；脚本屏蔽、网络失败会影响采集，“—”表示暂无记录。
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { V2WebsiteVisitReport, V2WebsiteVisitSearch } from '@apple-business/shared';
import { useAuthStore } from '@/stores/auth';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { formatV2DateTime } from '@/v2/utils/dateTime';

const props = defineProps<{ active: boolean }>();
const auth = useAuthStore();
const isAdmin = computed(() => auth.user?.roles.includes('admin') === true);
const days = ref<7 | 30>(7);
const ipFilter = ref('');
const sort = ref<'newest' | 'oldest'>('newest');
const view = ref<'daily' | 'records'>('daily');
const dailyPage = ref(1);
const input = ref<V2WebsiteVisitSearch>({ days: 7, page: 1, pageSize: 20, sort: 'newest' });
const revision = ref(0);
const query = useV2ModuleQuery<V2WebsiteVisitReport>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: () => 'website-visits-' + revision.value,
  enabled: () => props.active && isAdmin.value,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.searchWebsiteVisits(input.value, { signal })
});
const report = computed(() => query.data.value);
const queryError = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));
const visibleDays = computed(() =>
  [...(report.value?.daily ?? [])].reverse().slice((dailyPage.value - 1) * 7, dailyPage.value * 7)
);
const count = (value?: number | null) =>
  value == null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
const revealed = ref<Record<string, string>>({});
const pendingReveal = ref('');
const revealError = ref('');
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let revealGeneration = 0;

function clearRevealed() {
  revealGeneration += 1;
  revealed.value = {};
  pendingReveal.value = '';
  revealError.value = '';
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
function applySearch() {
  clearRevealed();
  input.value = {
    days: days.value,
    page: 1,
    pageSize: 20,
    sort: sort.value,
    ip: ipFilter.value.trim() || undefined
  };
  dailyPage.value = 1;
  revision.value += 1;
  void query.refresh();
}
function refresh() {
  clearRevealed();
  void query.refresh();
}
function changePage(page: number) {
  clearRevealed();
  input.value = { ...input.value, page };
  revision.value += 1;
  void query.refresh();
}
async function toggleIp(id: string) {
  if (revealed.value[id]) {
    delete revealed.value[id];
    clearTimeout(timers.get(id));
    timers.delete(id);
    return;
  }
  const generation = revealGeneration;
  pendingReveal.value = id;
  revealError.value = '';
  try {
    const result = await idBusinessV2WorkspaceApi.revealWebsiteVisitIp(id);
    if (generation !== revealGeneration || !props.active || !isAdmin.value) return;
    revealed.value[id] = result.ip;
    timers.set(
      id,
      setTimeout(() => {
        delete revealed.value[id];
        timers.delete(id);
      }, 30_000)
    );
  } catch (error) {
    if (generation === revealGeneration) revealError.value = getApiErrorMessage(error);
  } finally {
    if (pendingReveal.value === id) pendingReveal.value = '';
  }
}
watch(
  () => props.active,
  (active) => {
    clearRevealed();
    if (active && isAdmin.value) void query.refresh();
    if (!active) ipFilter.value = '';
  }
);
watch(isAdmin, () => clearRevealed());
onBeforeUnmount(clearRevealed);
</script>

<style scoped>
.v2-visits {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}
.v2-visits header {
  display: grid;
  gap: 4px;
}
.v2-visits header strong {
  font-size: 14px;
  line-height: 22px;
}
.v2-visits small,
.v2-visits__context,
.v2-visits footer {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}
.v2-visits__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0;
}
.v2-visits__search {
  display: flex;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.v2-visits__sort {
  width: 118px;
}
.v2-visits__metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--v2-border);
  border-radius: 6px;
  margin: 12px 0;
}
.v2-visits__metrics div {
  padding: 12px;
}
.v2-visits__metrics div + div {
  border-left: 1px solid var(--v2-border);
}
.v2-visits__metrics dt {
  font-size: 12px;
  line-height: 20px;
  color: var(--v2-text-soft);
}
.v2-visits__metrics dd {
  margin: 4px 0 0;
  font-size: 22px;
  line-height: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.v2-visits__notice {
  min-height: 42px;
  margin: 10px 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 20px;
}
.v2-visits__table-region {
  height: 380px;
  overflow: auto;
  min-width: 0;
}
.v2-visits__ip {
  overflow-wrap: anywhere;
}
.v2-visits :deep(.el-pagination) {
  margin: 12px 0;
  justify-content: center;
}
.v2-visits footer {
  margin-top: 16px;
}
@media (max-width: 480px) {
  .v2-visits {
    padding: 12px;
  }
}
</style>
