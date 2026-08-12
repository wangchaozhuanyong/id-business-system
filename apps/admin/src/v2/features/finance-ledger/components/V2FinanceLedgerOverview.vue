<template>
  <section class="v2-finance-ledger-overview" aria-label="钱包账户概览">
    <div class="v2-finance-ledger-overview__intro">
      <span class="v2-finance-ledger-overview__eyebrow">财务账务管理</span>
      <h2>钱包与账户总览</h2>
      <p>集中管理自有资金账户、供应商预付钱包、不可变流水与月度关账。</p>
    </div>

    <div class="v2-finance-ledger-overview__metrics" aria-label="当前财务账务指标">
      <article>
        <span>资金账户</span>
        <strong>{{ page.accounts.length }}</strong>
        <small>当前筛选结果</small>
      </article>
      <article>
        <span>启用账户</span>
        <strong>{{ activeAccountCount }}</strong>
        <small>可用于收付款</small>
      </article>
      <article>
        <span>供应商钱包</span>
        <strong>{{ page.wallets.length }}</strong>
        <small>按供应商与币种</small>
      </article>
      <article>
        <span>财务流水</span>
        <strong>{{ page.journalTotal }}</strong>
        <small>当前筛选总数</small>
      </article>
    </div>

    <div class="v2-finance-ledger-overview__actions">
      <span>{{ historyStatusLabel(page.settings?.historyStatus) }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="primaryAction" variant="primary" @click="primaryAction.run">
        <el-icon><component :is="primaryAction.icon" /></el-icon>
        {{ primaryAction.label }}
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
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
