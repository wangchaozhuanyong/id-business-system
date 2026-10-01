<template>
  <V2PageOverview
    class="v2-finance-ledger-overview"
    aria-label="钱包账户概览"
    title="钱包与账户总览"
    help="集中管理自有资金账户、供应商预付钱包、不可变流水与月度关账。"
    metrics-label="当前财务账务指标"
  >
    <template #metrics>
      <V2OverviewMetric label="资金账户" :value="page.accounts.length" note="当前筛选结果" />
      <V2OverviewMetric label="启用账户" :value="activeAccountCount" note="可用于收付款" />
      <V2OverviewMetric label="供应商钱包" :value="page.wallets.length" note="按供应商与币种" />
      <V2OverviewMetric label="财务流水" :value="page.journalTotal" note="当前筛选总数" />
    </template>
    <template #actions>
      <span>{{ historyStatusLabel(page.settings?.historyStatus) }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="primaryAction" variant="primary" @click="primaryAction.run">
        <el-icon><component :is="primaryAction.icon" /></el-icon>
        {{ primaryAction.label }}
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed, markRaw } from 'vue';
import type { Component, UnwrapNestedRefs } from 'vue';
import { Lock, Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { historyStatusLabel } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const activeAccountCount = computed(
  () => props.page.accounts.filter((item) => item.status === 'active').length
);
const primaryAction = computed<{ label: string; icon: Component; run: () => void } | null>(() => {
  if (props.page.activeTab === 'accounts' && props.page.canManage) {
    return { label: '新建资金账户', icon: markRaw(Plus), run: () => props.page.openAccount() };
  }
  if (props.page.activeTab === 'wallets' && props.page.canManage) {
    return { label: '新建供应商钱包', icon: markRaw(Plus), run: props.page.openWallet };
  }
  if (props.page.activeTab === 'periods' && props.page.canClose) {
    return { label: '月度关账', icon: markRaw(Lock), run: () => props.page.openPeriod('close') };
  }
  return null;
});
</script>
