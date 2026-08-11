<template>
  <section class="v2-audit-overview" aria-label="审计日志总览">
    <div class="v2-audit-overview__intro">
      <span>AUDIT CONTROL</span>
      <h2>审计日志总览</h2>
      <p>追踪业务变更、敏感资料访问和受控数据恢复入口。</p>
    </div>

    <div class="v2-audit-overview__metrics" aria-label="当前审计日志指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>当前日志类型</small>
      </article>
      <article>
        <span>本页记录</span>
        <strong>{{ page.currentItems.length }}</strong>
        <small>当前分页数据</small>
      </article>
      <article>
        <span>当前视图</span>
        <strong class="is-text">{{ currentTabLabel }}</strong>
        <small>日志口径已分离</small>
      </article>
      <article>
        <span>本页未批准访问</span>
        <strong>{{ pendingApprovalCount }}</strong>
        <small>仅敏感访问视图</small>
      </article>
    </div>

    <div class="v2-audit-overview__actions">
      <el-tag effect="plain" type="info">权限受控</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton :loading="page.exporting" @click="page.exportCurrent">
        <el-icon><Download /></el-icon>
        导出
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import { Download, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

const props = defineProps<{ page: AuditLogsPage }>();

const currentTabLabel = computed(() =>
  props.page.activeTab === 'operations' ? '操作审计' : '敏感访问'
);
const pendingApprovalCount = computed(() =>
  props.page.activeTab === 'sensitive_access'
    ? props.page.sensitiveItems.filter((item) => !item.approved).length
    : 0
);
</script>
