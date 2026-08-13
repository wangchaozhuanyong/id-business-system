<template>
  <el-drawer
    v-model="visible"
    :title="selectedOperation ? '操作审计详情' : '敏感访问详情'"
    size="min(720px, 94vw)"
    destroy-on-close
  >
    <div v-if="selectedOperation" class="v2-audit-detail">
      <V2DetailSummary
        heading-id="audit-operation-summary"
        eyebrow="审计对象"
        :title="operationObjectLabel(selectedOperation)"
        :description="`${selectedOperation.module} / ${selectedOperation.action}`"
        :metrics="[
          { label: '操作人', value: auditUserLabel(selectedOperation.user) },
          { label: '记录时间', value: formatAuditDate(selectedOperation.createdAt) }
        ]"
        :facts="[
          { label: '来源 IP', value: selectedOperation.ip || '—' },
          { label: '客户端', value: selectedOperation.userAgent || '—' },
          { label: '操作说明', value: selectedOperation.remark || '—' }
        ]"
      />
      <V2PanelSection heading-id="audit-operation-changes" title="变更内容" step="01">
        <div class="v2-audit-detail__changes">
          <section>
            <h4>变更前</h4>
            <pre>{{ formatAuditJson(selectedOperation.beforeData) }}</pre>
          </section>
          <section>
            <h4>变更后</h4>
            <pre>{{ formatAuditJson(selectedOperation.afterData) }}</pre>
          </section>
        </div>
      </V2PanelSection>
    </div>
    <V2DetailSummary
      v-else-if="selectedSensitiveAccess"
      heading-id="audit-sensitive-summary"
      eyebrow="敏感访问对象"
      :title="sensitiveObjectLabel(selectedSensitiveAccess)"
      :description="`${selectedSensitiveAccess.module} / ${selectedSensitiveAccess.fieldName}`"
      :metrics="[
        { label: '访问人', value: auditUserLabel(selectedSensitiveAccess.user) },
        { label: '审批状态', value: selectedSensitiveAccess.approved ? '已批准' : '未批准' }
      ]"
      :facts="[
        { label: '访问时间', value: formatAuditDate(selectedSensitiveAccess.createdAt) },
        { label: '来源 IP', value: selectedSensitiveAccess.ip || '—' },
        { label: '访问原因', value: selectedSensitiveAccess.accessReason || '—' },
        { label: '客户端', value: selectedSensitiveAccess.userAgent || '—' }
      ]"
    />
    <template v-if="selectedOperation" #footer>
      <div class="v2-audit-detail__footer">
        <span>
          {{
            restoreCandidate
              ? '发起后只生成数据治理恢复预览，不会立即恢复数据。'
              : '仅软删除审计可进入受控恢复流程。'
          }}
        </span>
        <AppButton variant="primary" :disabled="!restoreCandidate" @click="handleRestore">
          发起恢复
        </AppButton>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import {
  auditUserLabel,
  formatAuditDate,
  formatAuditJson,
  getOperationAuditRestoreCandidate,
  operationObjectLabel,
  sensitiveObjectLabel
} from '../audit-log-presentation';
import type { V2AuditLogRecord, V2SensitiveAccessLogRecord } from '../contracts';

const props = defineProps<{
  selectedOperation: V2AuditLogRecord | null;
  selectedSensitiveAccess: V2SensitiveAccessLogRecord | null;
}>();

const emit = defineEmits<{
  restore: [item: V2AuditLogRecord];
}>();

const visible = defineModel<boolean>({ required: true });

const restoreCandidate = computed(() =>
  props.selectedOperation ? getOperationAuditRestoreCandidate(props.selectedOperation) : null
);

function handleRestore() {
  if (!props.selectedOperation || !restoreCandidate.value) return;
  emit('restore', props.selectedOperation);
}
</script>

<style scoped>
.v2-audit-detail,
.v2-audit-detail__changes {
  display: grid;
  gap: 16px;
}

.v2-audit-detail__changes {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.v2-audit-detail__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-audit-detail__footer span {
  min-width: 0;
  color: var(--v3-text-soft);
  font-size: 13px;
  text-align: left;
}

.v2-audit-detail__changes section {
  min-width: 0;
}

.v2-audit-detail__changes h4 {
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
  .v2-audit-detail__changes {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-audit-detail__footer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
