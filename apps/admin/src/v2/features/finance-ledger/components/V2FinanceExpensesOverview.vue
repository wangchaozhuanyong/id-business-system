<template>
  <section class="v2-finance-expenses-overview" aria-label="经营开支概览">
    <div class="v2-finance-expenses-overview__intro">
      <span class="v2-finance-expenses-overview__eyebrow">经营开支管理</span>
      <h2>经营开支总览</h2>
      <p>统一记录日常经营支出，保留原币、交易汇率、人民币金额与更正审计链路。</p>
    </div>

    <div class="v2-finance-expenses-overview__metrics" aria-label="当前经营开支指标">
      <article>
        <span>开支记录</span>
        <strong>{{ page.expenseTotal }}</strong>
        <small>当前筛选总数</small>
      </article>
      <article>
        <span>本页记录</span>
        <strong>{{ page.expenses.length }}</strong>
        <small>当前页已加载</small>
      </article>
      <article>
        <span>已入账</span>
        <strong>{{ postedCount }}</strong>
        <small>当前页有效记录</small>
      </article>
      <article>
        <span>已冲销</span>
        <strong>{{ reversedCount }}</strong>
        <small>当前页审计记录</small>
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
        记录经营开支
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { historyStatusLabel } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

type FinanceLedgerPage = UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;

const props = defineProps<{ page: FinanceLedgerPage }>();
const postedCount = computed(
  () => props.page.expenses.filter((item) => item.status !== 'reversed').length
);
const reversedCount = computed(
  () => props.page.expenses.filter((item) => item.status === 'reversed').length
);
</script>
