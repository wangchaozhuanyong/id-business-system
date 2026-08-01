<template>
  <el-drawer
    v-model="visible"
    :title="selectedOperation ? '操作审计详情' : '敏感访问详情'"
    size="min(720px, 94vw)"
    destroy-on-close
  >
    <div v-if="selectedOperation" class="v2-audit-detail">
      <dl class="v2-audit-detail__meta">
        <div>
          <dt>操作人</dt>
          <dd>{{ auditUserLabel(selectedOperation.user) }}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{{ formatAuditDate(selectedOperation.createdAt) }}</dd>
        </div>
        <div>
          <dt>模块 / 动作</dt>
          <dd>{{ selectedOperation.module }} / {{ selectedOperation.action }}</dd>
        </div>
        <div>
          <dt>对象</dt>
          <dd>{{ operationObjectLabel(selectedOperation) }}</dd>
        </div>
        <div>
          <dt>IP</dt>
          <dd>{{ selectedOperation.ip || '—' }}</dd>
        </div>
        <div>
          <dt>客户端</dt>
          <dd>{{ selectedOperation.userAgent || '—' }}</dd>
        </div>
        <div class="v2-audit-detail__wide">
          <dt>说明</dt>
          <dd>{{ selectedOperation.remark || '—' }}</dd>
        </div>
      </dl>
      <div class="v2-audit-detail__changes">
        <section>
          <h3>变更前</h3>
          <pre>{{ formatAuditJson(selectedOperation.beforeData) }}</pre>
        </section>
        <section>
          <h3>变更后</h3>
          <pre>{{ formatAuditJson(selectedOperation.afterData) }}</pre>
        </section>
      </div>
    </div>
    <dl v-else-if="selectedSensitiveAccess" class="v2-audit-detail__meta">
      <div>
        <dt>访问人</dt>
        <dd>{{ auditUserLabel(selectedSensitiveAccess.user) }}</dd>
      </div>
      <div>
        <dt>时间</dt>
        <dd>{{ formatAuditDate(selectedSensitiveAccess.createdAt) }}</dd>
      </div>
      <div>
        <dt>模块 / 字段</dt>
        <dd>{{ selectedSensitiveAccess.module }} / {{ selectedSensitiveAccess.fieldName }}</dd>
      </div>
      <div>
        <dt>对象</dt>
        <dd>{{ sensitiveObjectLabel(selectedSensitiveAccess) }}</dd>
      </div>
      <div>
        <dt>审批状态</dt>
        <dd>{{ selectedSensitiveAccess.approved ? '已批准' : '未批准' }}</dd>
      </div>
      <div>
        <dt>IP</dt>
        <dd>{{ selectedSensitiveAccess.ip || '—' }}</dd>
      </div>
      <div class="v2-audit-detail__wide">
        <dt>访问原因</dt>
        <dd>{{ selectedSensitiveAccess.accessReason || '—' }}</dd>
      </div>
      <div class="v2-audit-detail__wide">
        <dt>客户端</dt>
        <dd>{{ selectedSensitiveAccess.userAgent || '—' }}</dd>
      </div>
    </dl>
  </el-drawer>
</template>

<script setup lang="ts">
import {
  auditUserLabel,
  formatAuditDate,
  formatAuditJson,
  operationObjectLabel,
  sensitiveObjectLabel
} from '../audit-log-presentation';
import type { V2AuditLogRecord, V2SensitiveAccessLogRecord } from '../contracts';

defineProps<{
  selectedOperation: V2AuditLogRecord | null;
  selectedSensitiveAccess: V2SensitiveAccessLogRecord | null;
}>();

const visible = defineModel<boolean>({ required: true });
</script>

<style scoped>
.v2-audit-detail,
.v2-audit-detail__meta,
.v2-audit-detail__changes {
  display: grid;
  gap: 16px;
}

.v2-audit-detail__meta {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}

.v2-audit-detail__meta div {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--v3-border);
  border-radius: 8px;
  background: var(--v3-surface-soft);
}

.v2-audit-detail__meta dt {
  margin-bottom: 6px;
  color: var(--v3-text-soft);
  font-size: 12px;
}

.v2-audit-detail__meta dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--v3-text);
}

.v2-audit-detail__wide {
  grid-column: 1 / -1;
}

.v2-audit-detail__changes {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.v2-audit-detail__changes section {
  min-width: 0;
}

.v2-audit-detail__changes h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

.v2-audit-detail__changes pre {
  min-height: 160px;
  max-height: 440px;
  margin: 0;
  padding: 14px;
  overflow: auto;
  border: 1px solid var(--v3-border);
  border-radius: 8px;
  background: var(--v3-bg);
  color: var(--v3-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .v2-audit-detail__meta,
  .v2-audit-detail__changes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
