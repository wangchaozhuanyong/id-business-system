<template>
  <section v-if="page.overview" class="v2-dashboard-section">
    <V2SectionHeading
      title="ID 库存与财务基线"
      help="账面成本只合计人民币余额成本和未售 ID 采购成本，不混合各国原币余额，也不代表完整资产。"
    >
      <template #actions>
        <AppButton
          v-if="page.overview.access.finance"
          size="small"
          variant="soft"
          @click="page.openRoute('/v2/data/analytics')"
        >
          打开经营分析
        </AppButton>
      </template>
    </V2SectionHeading>
    <article class="v2-dashboard-assets">
      <dl>
        <div>
          <dt>ID 记录总数</dt>
          <dd>{{ page.overview.assets.totalAccounts ?? '无权限' }}</dd>
        </div>
        <div>
          <dt>未售且未报损</dt>
          <dd>{{ page.overview.assets.availableAccounts ?? '无权限' }}</dd>
        </div>
        <div>
          <dt>库存账面成本</dt>
          <dd>{{ page.formatDashboardMoney(page.overview.assets.inventoryBookValueCny) }}</dd>
        </div>
        <div>
          <dt>财务历史基线</dt>
          <dd>{{ page.financeHistoryLabel(page.overview.assets.financeHistoryStatus) }}</dd>
        </div>
      </dl>
      <el-alert
        v-if="
          page.overview.assets.financeHistoryStatus &&
          page.overview.assets.financeHistoryStatus !== 'completed'
        "
        type="warning"
        title="历史数据尚未完整确认，仪表盘不将库存账面成本称为完整总资产。"
        show-icon
        :closable="false"
      />
    </article>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useDashboardPage } from '../useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{ page: DashboardPage }>();
</script>

<style scoped>
.v2-dashboard-section,
.v2-dashboard-assets {
  display: grid;
  min-width: 0;
  gap: 12px;
}

.v2-dashboard-assets {
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-assets dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}

.v2-dashboard-assets dl div {
  display: grid;
  min-width: 0;
  gap: 5px;
  padding: 12px;
  border-radius: var(--v3-radius-sm);
  background: var(--v2-surface-soft);
}

.v2-dashboard-assets dt {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-assets dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 15px;
  font-weight: var(--v3-font-weight-bold);
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .v2-dashboard-assets dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 540px) {
  .v2-dashboard-assets dl {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
