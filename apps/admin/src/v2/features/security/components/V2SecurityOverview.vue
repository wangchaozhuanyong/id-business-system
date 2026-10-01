<template>
  <V2PageOverview
    class="v2-security-overview"
    aria-label="安全中心总览"
    title="安全中心总览"
    help="统一监控登录风险、在线会话、MFA 策略和访问白名单。"
    metrics-label="当前安全指标"
  >
    <template #metrics>
      <V2OverviewMetric
        label="失败登录"
        :value="page.overview.failedLoginCount"
        note="查看失败记录"
        interactive
        @click="page.selectMetric('failed')"
      />
      <V2OverviewMetric
        label="异常登录"
        :value="page.overview.abnormalLoginCount"
        note="查看风险记录"
        interactive
        @click="page.selectMetric('abnormal')"
      />
      <V2OverviewMetric
        label="在线会话"
        :value="page.overview.activeSessionCount"
        note="管理活动设备"
        interactive
        @click="page.selectMetric('sessions')"
      />
      <V2OverviewMetric
        label="启用白名单"
        :value="page.overview.enabledWhitelistCount"
        note="查看访问边界"
        interactive
        @click="page.selectMetric('whitelist')"
      />
    </template>
    <template #actions>
      <el-tag class="v2-overview-access-tag" effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

defineProps<{ page: SecurityPage }>();
</script>
