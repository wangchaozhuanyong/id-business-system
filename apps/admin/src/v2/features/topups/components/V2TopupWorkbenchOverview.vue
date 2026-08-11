<template>
  <section class="v2-topup-overview" aria-label="ID 加额工作台概览">
    <div class="v2-topup-overview__intro">
      <span class="v2-topup-overview__eyebrow">BALANCE WORKBENCH</span>
      <h2>ID 加额总览</h2>
      <p>查找可用 ID 并完成礼品卡入账，余额、成本、卡商资金和财务流水继续由系统联动校验。</p>
    </div>

    <div class="v2-topup-overview__metrics" aria-label="当前页 ID 加额指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配 ID</small>
      </article>
      <article>
        <span>当前页</span>
        <strong>{{ page.items.length }}</strong>
        <small>本页已加载</small>
      </article>
      <article>
        <span>状态正常</span>
        <strong>{{ normalCount }}</strong>
        <small>当前页正常 ID</small>
      </article>
      <article>
        <span>加卡记录</span>
        <strong>{{ topupRecordCount }}</strong>
        <small>当前页累计笔数</small>
      </article>
    </div>

    <div class="v2-topup-overview__actions">
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadWorkbench">
        <el-icon><Refresh /></el-icon>
        刷新数据
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const normalCount = computed(
  () => props.page.items.filter((item) => item.status.code === 'normal').length
);
const topupRecordCount = computed(() =>
  props.page.items.reduce((total, item) => total + item.topupRecordCount, 0)
);
</script>
