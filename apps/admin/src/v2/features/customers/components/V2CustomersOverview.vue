<template>
  <section class="v2-customers-overview" aria-label="客户资料概览">
    <div class="v2-customers-overview__intro">
      <span class="v2-customers-overview__eyebrow">CUSTOMER RECORDS</span>
      <h2>客户资料总览</h2>
      <p>集中维护客户来源、标签和历史业务，敏感联系方式默认脱敏。</p>
    </div>

    <div class="v2-customers-overview__metrics" aria-label="当前页客户指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配客户</small>
      </article>
      <article>
        <span>当前页</span>
        <strong>{{ page.items.length }}</strong>
        <small>本页已加载</small>
      </article>
      <article>
        <span>启用资料</span>
        <strong>{{ activeCount }}</strong>
        <small>当前页正常客户</small>
      </article>
      <article>
        <span>敏感联系方式</span>
        <strong>{{ sensitiveContactCount }}</strong>
        <small>当前页受控查看</small>
      </article>
    </div>

    <div class="v2-customers-overview__actions">
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadCustomers">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新增客户
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useCustomersPage } from '../useCustomersPage';

type CustomersPage = UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;

const props = defineProps<{
  page: CustomersPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.recordStatus === 'active').length
);
const sensitiveContactCount = computed(
  () => props.page.items.filter((item) => item.hasPhone || item.hasWhatsapp).length
);
</script>
