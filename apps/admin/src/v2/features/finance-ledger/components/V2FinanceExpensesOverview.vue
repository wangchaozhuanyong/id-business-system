<template>
  <section class="v2-finance-expenses-overview" aria-label="收支记账概览">
    <div class="v2-finance-expenses-overview__intro">
      <span class="v2-finance-expenses-overview__eyebrow">经营收支管理</span>
      <h2>收支记账总览</h2>
      <p>收入与开支统一留痕，区分经营收入、股东投入和借入资金，避免虚增利润。</p>
    </div>

    <div class="v2-finance-expenses-overview__metrics" aria-label="当前收支指标">
      <article>
        <span>收入记录</span>
        <strong>{{ page.inflowTotal }}</strong>
        <small>当前收入筛选总数</small>
      </article>
      <article>
        <span>开支记录</span>
        <strong>{{ page.expenseTotal }}</strong>
        <small>当前开支筛选总数</small>
      </article>
      <article>
        <span>经营收入</span>
        <strong>{{ formatCny(page.inflowSummary.operatingIncomeCny) }}</strong>
        <small>计入经营利润</small>
      </article>
      <article>
        <span>全部资金流入</span>
        <strong>{{ formatCny(page.inflowSummary.totalInflowCny) }}</strong>
        <small>含股东投入与借入资金</small>
      </article>
    </div>

    <div class="v2-finance-expenses-overview__actions">
      <span>{{ historyStatusLabel(page.settings?.historyStatus) }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="page.canPost" variant="primary" @click="page.openExpense()">
        <el-icon><Plus /></el-icon>
        开支记账
      </AppButton>
      <AppButton v-if="page.canPost" variant="primary" @click="page.openInflow()">
        <el-icon><Plus /></el-icon>
        收入记账
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { formatCny, historyStatusLabel } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

defineProps<{ page: FinanceLedgerPage }>();
</script>
