<template>
  <section v-if="page.overview" class="v2-dashboard-activity">
    <article class="v2-dashboard-panel">
      <V2SectionHeading title="最近订单" help="按订单创建时间显示最近 5 条记录。" />
      <V2Table
        :schema="v2TableSchemas.dashboard.activity"
        class="v2-records-table"
        :data="page.overview.recentOrders"
        scrollbar-always-on
        show-overflow-tooltip
      >
        <template #empty>
          <div class="v2-dashboard-empty">
            <strong>{{ page.overview.access.orders ? '暂无订单' : '无订单查看权限' }}</strong>
          </div>
        </template>
        <V2TableColumn :definition="v2TableSchemas.dashboard.activity.columns[0]" prop="orderNo" />
        <V2TableColumn
          :definition="v2TableSchemas.dashboard.activity.columns[1]"
          prop="customer.name"
        />
        <V2TableColumn
          :definition="v2TableSchemas.dashboard.activity.columns[2]"
          prop="serviceOption.name"
        />
        <V2TableColumn :definition="v2TableSchemas.dashboard.activity.columns[3]" prop="status">
          <template #default="{ row }">
            <el-tag :type="page.dashboardOrderStatusMeta(row.status).type" effect="plain">
              {{ page.dashboardOrderStatusMeta(row.status).label }}
            </el-tag>
          </template>
        </V2TableColumn>
        <V2TableColumn
          :definition="v2TableSchemas.dashboard.activity.columns[4]"
          prop="receivedAmount"
        >
          <template #default="{ row }">{{
            page.formatDashboardMoney(row.receivedAmount)
          }}</template>
        </V2TableColumn>
        <V2TableColumn :definition="v2TableSchemas.dashboard.activity.columns[5]" prop="createdAt">
          <template #default="{ row }">{{ page.formatDashboardDate(row.createdAt) }}</template>
        </V2TableColumn>
        <V2TableActionColumn :definition="v2TableSchemas.dashboard.activity.columns[6]">
          <template #default>
            <AppButton size="small" variant="soft" @click="page.openRoute('/v2/orders')">
              查看
            </AppButton>
          </template>
        </V2TableActionColumn>
      </V2Table>
    </article>

    <article class="v2-dashboard-panel">
      <V2SectionHeading
        title="到期待办"
        :help="`显示已逾期和未来 ${page.overview.warningDays} 天内到期的最前 5 条记录。`"
      />
      <div v-if="page.overview.upcomingRenewals.length" class="v2-dashboard-renewals">
        <article v-for="item in page.overview.upcomingRenewals" :key="item.id">
          <div>
            <strong>{{ item.customer.name }} · {{ item.serviceOption.name }}</strong>
            <span>{{ item.account.appleIdMasked }}</span>
          </div>
          <div>
            <span>到期时间</span>
            <strong>{{ page.formatDashboardDate(item.dueAt) }}</strong>
          </div>
          <AppButton size="small" variant="soft" @click="page.openRoute('/v2/workbench/renewals')">
            处理
          </AppButton>
        </article>
      </div>
      <div v-else class="v2-dashboard-empty">
        <strong>{{ page.overview.access.renewals ? '当前无到期待办' : '无续费查看权限' }}</strong>
      </div>
    </article>

    <V2DashboardAssets :page="page" />

    <article class="v2-dashboard-panel">
      <V2SectionHeading
        title="团队动态"
        help="只显示最近 5 条审计摘要，不包含变更前后详情或敏感字段。"
      />
      <ol v-if="page.overview.recentAudits.length" class="v2-dashboard-audit-list">
        <li v-for="item in page.overview.recentAudits" :key="item.id">
          <div>
            <div class="v2-dashboard-audit-list__event">
              <time>{{ page.formatDashboardTime(item.createdAt) }}</time>
              <strong>
                {{ item.user?.displayName || item.user?.username || '系统' }}
                · {{ page.auditActionLabel(item.action) }}
              </strong>
            </div>
            <span>{{ item.module }}{{ item.objectType ? ` · ${item.objectType}` : '' }}</span>
          </div>
        </li>
      </ol>
      <div v-else class="v2-dashboard-empty">
        <strong>{{ page.overview.access.audit ? '暂无审计动态' : '无审计日志权限' }}</strong>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2Table from '@/v2/components/V2Table.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import type { useDashboardPage } from '../useDashboardPage';
import V2DashboardAssets from './V2DashboardAssets.vue';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{ page: DashboardPage }>();
</script>

<style scoped>
.v2-dashboard-activity {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, 0.75fr);
  gap: 14px;
}

.v2-dashboard-panel {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-panel:last-child,
.v2-dashboard-activity > :deep(.v2-dashboard-section) {
  grid-column: 1 / -1;
}

.v2-dashboard-panel:last-child > :deep(.v2-section-heading) {
  box-sizing: border-box;
  min-height: 42px;
  padding-block: 7px;
}

.v2-dashboard-panel > :deep(.v2-section-heading) {
  min-height: 48px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-panel > :deep(.v2-records-table .el-table__header-wrapper th.el-table__cell) {
  height: 38px;
}

.v2-dashboard-panel > :deep(.v2-records-table .el-table__body-wrapper td.el-table__cell) {
  height: 42px;
  padding-block: 4px;
}

.v2-dashboard-empty {
  display: grid;
  min-height: 132px;
  place-content: center;
  color: var(--v2-text-soft);
  font-size: 13px;
}

.v2-dashboard-renewals,
.v2-dashboard-audit-list {
  display: grid;
  min-width: 0;
  margin: 0;
  padding: 0 14px 10px;
}

.v2-dashboard-renewals > article {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  min-height: 56px;
  padding: 8px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-renewals > article:last-child,
.v2-dashboard-audit-list > li:last-child {
  border-bottom: 0;
}

.v2-dashboard-renewals > article > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-dashboard-renewals strong,
.v2-dashboard-audit-list strong {
  color: var(--v2-text);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.v2-dashboard-renewals span,
.v2-dashboard-audit-list span,
.v2-dashboard-audit-list time {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-audit-list {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
  list-style: none;
}

.v2-dashboard-audit-list > li {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 4px;
  padding: 7px 12px;
  border-top: 2px solid color-mix(in srgb, var(--v2-accent) 55%, var(--v2-border));
  border-right: 1px solid var(--v2-border-soft);
}

.v2-dashboard-audit-list > li > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-dashboard-audit-list__event {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 6px;
}

.v2-dashboard-audit-list__event strong {
  min-width: 0;
}

.v2-dashboard-audit-list > li:last-child {
  border-right: 0;
}

.v2-dashboard-audit-list time {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .v2-dashboard-activity {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-dashboard-panel:first-child {
    grid-column: auto;
  }

  .v2-dashboard-audit-list {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-dashboard-audit-list > li {
    border-top-width: 1px;
    border-right: 0;
  }
}

@media (max-width: 600px) {
  .v2-dashboard-renewals > article,
  .v2-dashboard-audit-list > li {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .v2-dashboard-renewals > article > div:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
