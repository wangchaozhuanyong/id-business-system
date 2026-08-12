<template>
  <div class="v2-renewals-overview-stack">
    <section class="v2-renewals-overview" aria-label="续费工作台概览">
      <div class="v2-renewals-overview__intro">
        <span class="v2-renewals-overview__eyebrow">续费工作台</span>
        <h2>续费管理总览</h2>
        <p>集中处理临期与到期业务，续费动作继续受权限、时间窗口和余额校验控制。</p>
      </div>

      <div class="v2-renewals-overview__metrics" aria-label="当前页续费指标">
        <article>
          <span>筛选结果</span>
          <strong>{{ page.total }}</strong>
          <small>全部匹配记录</small>
        </article>
        <article>
          <span>当前页</span>
          <strong>{{ page.items.length }}</strong>
          <small>本页已加载</small>
        </article>
        <article>
          <span>续费预警</span>
          <strong>{{ warningCount }}</strong>
          <small>当前页临期记录</small>
        </article>
        <article>
          <span>可执行续费</span>
          <strong>{{ actionableCount }}</strong>
          <small>当前页时间窗内</small>
        </article>
      </div>

      <div class="v2-renewals-overview__actions">
        <AppButton
          v-if="page.canManageWarning"
          variant="ghost"
          title="设置续费提前预警天数"
          @click="page.openWarningSettings"
        >
          <el-icon><Setting /></el-icon>
          预警设置
        </AppButton>
        <AppButton variant="ghost" :disabled="page.loading" @click="page.loadWorkbench">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
      </div>
    </section>

    <V2StatusStrip
      :items="page.renewalStatusStripItems"
      :active-key="page.activeWarningScope"
      aria-label="续费到期预警汇总"
      @select="page.selectWarningScope"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh, Setting } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import type { useRenewalsPage } from '../useRenewalsPage';

type RenewalsPage = UnwrapNestedRefs<ReturnType<typeof useRenewalsPage>>;

const props = defineProps<{
  page: RenewalsPage;
}>();

const warningCount = computed(
  () => props.page.items.filter((item) => item.warningState === 'upcoming').length
);
const actionableCount = computed(
  () => props.page.items.filter((item) => item.withinActionWindow).length
);
</script>
