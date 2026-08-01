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

    <article class="v2-dashboard-panel">
      <V2SectionHeading
        title="团队动态"
        help="只显示最近 5 条审计摘要，不包含变更前后详情或敏感字段。"
      />
      <ol v-if="page.overview.recentAudits.length" class="v2-dashboard-audit-list">
        <li v-for="item in page.overview.recentAudits" :key="item.id">
          <span class="v2-dashboard-audit-list__dot" aria-hidden="true" />
          <div>
            <strong>
              {{ item.user?.displayName || item.user?.username || '系统' }}
              · {{ page.auditActionLabel(item.action) }}
            </strong>
            <span>{{ item.module }}{{ item.objectType ? ` · ${item.objectType}` : '' }}</span>
          </div>
          <time>{{ page.formatDashboardDate(item.createdAt) }}</time>
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

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{ page: DashboardPage }>();
</script>

<style scoped>
.v2-dashboard-activity {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.v2-dashboard-panel {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-panel:first-child {
  grid-column: 1 / -1;
}

.v2-dashboard-panel > :deep(.v2-section-heading) {
  padding: 16px 16px 0;
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
  padding: 0 16px 16px;
}

.v2-dashboard-renewals > article {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
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
  list-style: none;
}

.v2-dashboard-audit-list > li {
  display: grid;
  min-width: 0;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-audit-list__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--v2-accent);
}

.v2-dashboard-audit-list > li > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

@media (max-width: 900px) {
  .v2-dashboard-activity {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-dashboard-panel:first-child {
    grid-column: auto;
  }
}

@media (max-width: 600px) {
  .v2-dashboard-renewals > article,
  .v2-dashboard-audit-list > li {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .v2-dashboard-audit-list__dot {
    display: none;
  }

  .v2-dashboard-renewals > article > div:nth-child(2) {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
