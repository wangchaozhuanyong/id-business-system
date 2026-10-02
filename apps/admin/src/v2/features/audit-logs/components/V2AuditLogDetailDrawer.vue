<template>
  <el-drawer
    v-model="visible"
    :title="selectedOperation ? '操作记录详情' : '敏感资料查看详情'"
    size="min(820px, 94vw)"
    destroy-on-close
  >
    <div v-if="selectedOperation" class="v2-audit-detail">
      <V2DetailSummary
        heading-id="audit-operation-summary"
        eyebrow="涉及资料"
        :title="operationObjectLabel(selectedOperation)"
        :description="auditActionLabel(selectedOperation.action)"
        :facts="[
          {
            label: '操作人',
            value: auditUserLabel(selectedOperation.user, selectedOperation.userId)
          },
          { label: '操作时间', value: formatAuditDate(selectedOperation.createdAt) },
          {
            label: '业务分类',
            value: auditModuleLabel(selectedOperation.module, selectedOperation.action)
          }
        ]"
      />
      <p class="v2-audit-detail__description">
        {{ auditRemarkLabel(selectedOperation.remark, selectedOperation.action) }}
      </p>
      <V2PanelSection heading-id="audit-operation-changes" title="具体改了什么" step="01">
        <p class="v2-audit-detail__notice">{{ operationChangeNotice(selectedOperation) }}</p>
        <div v-if="changes.length" class="v2-audit-comparison">
          <div class="v2-audit-comparison__heading" aria-hidden="true">
            <span>资料项目</span><span>操作前</span><span>操作后</span>
          </div>
          <dl v-for="change in changes" :key="change.key" class="v2-audit-comparison__row">
            <dt>{{ change.label }}</dt>
            <dd>
              <span class="v2-audit-comparison__mobile-label">操作前</span>{{ change.before }}
            </dd>
            <dd><span class="v2-audit-comparison__mobile-label">操作后</span>{{ change.after }}</dd>
          </dl>
        </div>
        <p v-else class="v2-audit-detail__notice">没有可显示的字段变化，请查看上方操作说明。</p>
      </V2PanelSection>
      <V2PanelSection heading-id="audit-operation-restore" title="这条记录能恢复吗" step="02">
        <p class="v2-audit-detail__description">
          {{ operationRestoreExplanation(selectedOperation, Boolean(restoreCandidate)) }}
        </p>
      </V2PanelSection>
      <el-collapse>
        <el-collapse-item title="排查信息（记录编号、登录设备）" name="technical">
          <dl class="v2-audit-detail__technical">
            <div>
              <dt>日志编号</dt>
              <dd>{{ selectedOperation.id }}</dd>
            </div>
            <div>
              <dt>资料编号</dt>
              <dd>{{ selectedOperation.objectId || '未记录' }}</dd>
            </div>
            <div>
              <dt>登录地址</dt>
              <dd>{{ selectedOperation.ip || '未记录' }}</dd>
            </div>
            <div>
              <dt>登录设备</dt>
              <dd>{{ selectedOperation.userAgent || '未记录' }}</dd>
            </div>
          </dl>
        </el-collapse-item>
      </el-collapse>
    </div>
    <div v-else-if="selectedSensitiveAccess" class="v2-audit-detail">
      <V2DetailSummary
        heading-id="audit-sensitive-summary"
        eyebrow="涉及资料"
        :title="sensitiveObjectLabel(selectedSensitiveAccess)"
        :description="`查看${auditFieldLabel(selectedSensitiveAccess.fieldName)}`"
        :facts="[
          {
            label: '查看人',
            value: auditUserLabel(selectedSensitiveAccess.user, selectedSensitiveAccess.userId)
          },
          { label: '查看时间', value: formatAuditDate(selectedSensitiveAccess.createdAt) },
          { label: '是否获准', value: selectedSensitiveAccess.approved ? '已获准' : '未获准' },
          {
            label: '查看原因',
            value: auditAccessReasonLabel(selectedSensitiveAccess.accessReason)
          },
          { label: '登录地址', value: selectedSensitiveAccess.ip || '未记录' }
        ]"
      />
      <p class="v2-audit-detail__notice">
        这里记录谁查看了敏感资料和查看原因，不展示密码、密钥或完整卡号，也不修改业务数据。
      </p>
    </div>
    <template #footer>
      <div class="v2-audit-detail__footer">
        <span v-if="restoreCandidate">申请后先核对资料，另一名管理员审批通过后才能恢复。</span>
        <AppButton @click="visible = false">关闭</AppButton>
        <AppButton
          v-if="selectedOperation && supportsAuditFieldRestore(selectedOperation)"
          variant="primary"
          @click="$emit('restore-fields', selectedOperation)"
          >恢复修改前的内容</AppButton
        >
        <AppButton
          v-if="selectedOperation && restoreCandidate"
          variant="primary"
          @click="handleRestore"
          >申请恢复这条资料</AppButton
        >
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
  auditAccessReasonLabel,
  auditActionLabel,
  auditFieldLabel,
  auditModuleLabel,
  auditRemarkLabel,
  auditUserLabel,
  formatAuditDate,
  getOperationAuditRestoreCandidate,
  operationObjectLabel,
  sensitiveObjectLabel,
  operationAuditChanges,
  operationChangeNotice,
  operationRestoreExplanation
} from '../audit-log-presentation';
import type { V2AuditLogRecord, V2SensitiveAccessLogRecord } from '../contracts';
import { supportsAuditFieldRestore } from '../audit-log-changes';

const props = defineProps<{
  selectedOperation: V2AuditLogRecord | null;
  selectedSensitiveAccess: V2SensitiveAccessLogRecord | null;
}>();
const emit = defineEmits<{
  restore: [item: V2AuditLogRecord];
  'restore-fields': [item: V2AuditLogRecord];
}>();
const visible = defineModel<boolean>({ required: true });
const restoreCandidate = computed(() =>
  props.selectedOperation ? getOperationAuditRestoreCandidate(props.selectedOperation) : null
);
const changes = computed(() =>
  props.selectedOperation ? operationAuditChanges(props.selectedOperation) : []
);
function handleRestore() {
  if (props.selectedOperation && restoreCandidate.value) emit('restore', props.selectedOperation);
}
</script>

<style scoped>
.v2-audit-detail {
  display: grid;
  gap: var(--v2-layout-panel-gap);
}
.v2-audit-detail__description,
.v2-audit-detail__notice {
  margin: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
  font-size: 13px;
}
.v2-audit-detail__notice {
  color: var(--v2-text-soft);
  margin-bottom: 12px;
}
.v2-audit-comparison {
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius-sm);
  overflow: hidden;
}
.v2-audit-comparison__heading,
.v2-audit-comparison__row {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) repeat(2, minmax(0, 1fr));
  margin: 0;
}
.v2-audit-comparison__heading {
  background: var(--v2-surface-muted);
}
.v2-audit-comparison__heading span,
.v2-audit-comparison__row dt,
.v2-audit-comparison__row dd {
  margin: 0;
  padding: 12px;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.v2-audit-comparison__row {
  border-top: 1px solid var(--v2-border);
}
.v2-audit-comparison__row dt {
  font-weight: var(--v3-font-weight-bold);
}
.v2-audit-comparison__row dd {
  white-space: pre-wrap;
}
.v2-audit-comparison__mobile-label {
  display: none;
}
.v2-audit-detail__technical {
  display: grid;
  gap: 12px;
  margin: 0;
}
.v2-audit-detail__technical div {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 12px;
}
.v2-audit-detail__technical dt,
.v2-audit-detail__technical dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.v2-audit-detail__technical dt {
  color: var(--v2-text-soft);
}
.v2-audit-detail__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.v2-audit-detail__footer span {
  flex: 1 1 220px;
  color: var(--v2-text-soft);
  font-size: 12px;
  text-align: left;
}
@media (max-width: 640px) {
  .v2-audit-comparison__heading {
    display: none;
  }
  .v2-audit-comparison__row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .v2-audit-comparison__row dt {
    grid-column: 1 / -1;
    background: var(--v2-surface-muted);
  }
  .v2-audit-comparison__mobile-label {
    display: block;
    margin-bottom: 4px;
    color: var(--v2-text-soft);
    font-size: 12px;
  }
}
</style>
