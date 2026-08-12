<template>
  <section class="v2-security-overview" aria-label="安全中心总览">
    <div class="v2-security-overview__intro">
      <span>安全访问管理</span>
      <h2>安全中心总览</h2>
      <p>统一监控登录风险、在线会话、MFA 策略和访问白名单。</p>
    </div>

    <div class="v2-security-overview__metrics" aria-label="当前安全指标">
      <button type="button" @click="page.selectMetric('failed')">
        <span>失败登录</span>
        <strong>{{ page.overview.failedLoginCount }}</strong>
        <small>查看失败记录</small>
      </button>
      <button type="button" @click="page.selectMetric('abnormal')">
        <span>异常登录</span>
        <strong>{{ page.overview.abnormalLoginCount }}</strong>
        <small>查看风险记录</small>
      </button>
      <button type="button" @click="page.selectMetric('sessions')">
        <span>在线会话</span>
        <strong>{{ page.overview.activeSessionCount }}</strong>
        <small>管理活动设备</small>
      </button>
      <button type="button" @click="page.selectMetric('whitelist')">
        <span>启用白名单</span>
        <strong>{{ page.overview.enabledWhitelistCount }}</strong>
        <small>查看访问边界</small>
      </button>
    </div>

    <div class="v2-security-overview__actions">
      <el-tag effect="plain" type="info">管理员专用</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

defineProps<{ page: SecurityPage }>();
</script>
