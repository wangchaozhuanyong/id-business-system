<template>
  <el-drawer
    v-model="page.restoreDrawerVisible"
    title="生成回收站恢复预览"
    size="min(620px, 94vw)"
    destroy-on-close
    :before-close="beforeRestoreClose"
  >
    <div class="v2-governance-drawer">
      <el-alert
        type="warning"
        title="此步骤只冻结影响预览，不会立即恢复；必须由另一名管理员审批。"
        :closable="false"
        show-icon
      />
      <section class="v2-governance-selection-summary">
        <strong>已选择 {{ page.selectedRecycleItems.length }} 条</strong>
        <div>
          <el-tag
            v-for="item in page.selectedRecycleItems.slice(0, 12)"
            :key="`${item.entity}:${item.id}`"
            effect="plain"
          >
            {{ page.recycleEntityLabels[item.entity] }} · {{ item.label }}
          </el-tag>
          <span v-if="page.selectedRecycleItems.length > 12">
            另有 {{ page.selectedRecycleItems.length - 12 }} 条
          </span>
        </div>
      </section>
      <el-form
        ref="restoreFormRef"
        class="v2-horizontal-form"
        :model="page.restoreForm"
        :rules="page.restoreRules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
      >
        <el-form-item label="申请原因" prop="reason">
          <el-input
            v-model="page.restoreForm.reason"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="说明误删除原因、核对结果和恢复目的"
          />
        </el-form-item>
        <el-form-item label="备份证据" prop="backupEvidence">
          <el-input
            v-model="page.restoreForm.backupEvidence"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="填写备份编号、时间、环境和可恢复性核对记录"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="page.mutationError"
        type="error"
        :title="page.mutationError"
        :closable="false"
        show-icon
      />
    </div>
    <template #footer>
      <AppButton
        variant="ghost"
        :disabled="page.mutationBusy === 'restore'"
        @click="page.restoreDrawerVisible = false"
      >
        取消
      </AppButton>
      <AppButton
        variant="primary"
        :loading="page.mutationBusy === 'restore'"
        @click="page.submitRestore(restoreFormRef)"
      >
        生成不可变预览
      </AppButton>
    </template>
  </el-drawer>

  <el-drawer
    v-model="page.cleanupDrawerVisible"
    title="生成汇率历史清理预览"
    size="min(620px, 94vw)"
    destroy-on-close
    :before-close="beforeCleanupClose"
  >
    <div class="v2-governance-drawer">
      <el-alert
        type="warning"
        title="只扫描已结束、超过保留期且没有礼品卡引用的汇率运行；通用业务数据不会被删除。"
        :closable="false"
        show-icon
      />
      <el-form
        ref="cleanupFormRef"
        class="v2-horizontal-form"
        :model="page.cleanupForm"
        :rules="page.cleanupRules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
      >
        <el-form-item label="保留天数" prop="olderThanDays">
          <el-input-number
            v-model="page.cleanupForm.olderThanDays"
            :min="30"
            :max="3650"
            :step="30"
            controls-position="right"
          />
        </el-form-item>
        <el-form-item label="申请原因" prop="reason">
          <el-input
            v-model="page.cleanupForm.reason"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="说明清理目的和保留策略"
          />
        </el-form-item>
        <el-form-item label="备份证据" prop="backupEvidence">
          <el-input
            v-model="page.cleanupForm.backupEvidence"
            type="textarea"
            :rows="4"
            maxlength="2000"
            show-word-limit
            placeholder="填写备份编号、时间、环境和恢复演练证据"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="page.mutationError"
        type="error"
        :title="page.mutationError"
        :closable="false"
        show-icon
      />
    </div>
    <template #footer>
      <AppButton
        variant="ghost"
        :disabled="page.mutationBusy === 'cleanup'"
        @click="page.cleanupDrawerVisible = false"
      >
        取消
      </AppButton>
      <AppButton
        variant="primary"
        :loading="page.mutationBusy === 'cleanup'"
        @click="page.submitCleanup(cleanupFormRef)"
      >
        生成不可变预览
      </AppButton>
    </template>
  </el-drawer>

  <el-drawer
    v-model="page.decisionDrawerVisible"
    :title="`审批治理任务 · ${page.decisionTarget?.jobNo ?? ''}`"
    size="min(560px, 94vw)"
    destroy-on-close
    :before-close="beforeDecisionClose"
  >
    <div class="v2-governance-drawer">
      <el-alert
        type="warning"
        title="审批只对当前预览哈希有效；审批记录写入后不可修改。"
        :closable="false"
        show-icon
      />
      <section v-if="page.decisionTarget" class="v2-governance-decision-summary">
        <div>
          <span>任务类型</span
          ><strong>{{ page.governanceJobTypeLabels[page.decisionTarget.type] }}</strong>
        </div>
        <div>
          <span>影响数量</span><strong>{{ page.decisionTarget.totalItems }} 条</strong>
        </div>
        <div>
          <span>申请人</span><strong>{{ page.decisionTarget.requestedBy.displayName }}</strong>
        </div>
        <div>
          <span>预览哈希</span
          ><strong>{{ page.shortHash(page.decisionTarget.previewHash) }}</strong>
        </div>
        <div class="wide">
          <span>备份证据</span><strong>{{ page.decisionTarget.backupEvidence }}</strong>
        </div>
      </section>
      <el-form
        ref="decisionFormRef"
        class="v2-horizontal-form"
        :model="page.decisionForm"
        :rules="page.decisionRules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
      >
        <el-form-item label="审批决定" prop="decision">
          <el-radio-group v-model="page.decisionForm.decision">
            <el-radio value="approved">通过</el-radio>
            <el-radio value="rejected">驳回</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="审批意见" prop="reason">
          <el-input
            v-model="page.decisionForm.reason"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="说明备份、范围和风险复核结论"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="page.mutationError"
        type="error"
        :title="page.mutationError"
        :closable="false"
        show-icon
      />
    </div>
    <template #footer>
      <AppButton
        variant="ghost"
        :disabled="page.mutationBusy === 'decision'"
        @click="page.decisionDrawerVisible = false"
      >
        取消
      </AppButton>
      <AppButton
        :variant="page.decisionForm.decision === 'approved' ? 'primary' : 'danger'"
        :loading="page.mutationBusy === 'decision'"
        @click="page.submitDecision(decisionFormRef)"
      >
        确认{{ page.decisionForm.decision === 'approved' ? '通过' : '驳回' }}
      </AppButton>
    </template>
  </el-drawer>

  <el-drawer
    v-model="page.detailDrawerVisible"
    title="数据治理任务详情"
    size="min(880px, 96vw)"
    destroy-on-close
  >
    <V2AsyncRegion
      skeleton="table"
      :phase="page.detailQueryPhase"
      :error="page.detailError"
      loading-title="正在读取任务明细"
      refreshing-title="正在更新任务明细"
      error-title="任务明细加载失败"
      @retry="page.refreshDetail"
    >
      <div v-if="page.detail" class="v2-governance-detail">
        <section class="v2-governance-detail-summary">
          <div>
            <span>任务编号</span><strong>{{ page.detail.jobNo }}</strong>
          </div>
          <div>
            <span>任务状态</span
            ><el-tag :type="page.governanceJobStatusMeta[page.detail.status].type" effect="plain">{{
              page.governanceJobStatusMeta[page.detail.status].label
            }}</el-tag>
          </div>
          <div>
            <span>申请人</span><strong>{{ page.detail.requestedBy.displayName }}</strong>
          </div>
          <div>
            <span>审批人</span
            ><strong>{{ page.detail.approval?.approver.displayName ?? '—' }}</strong>
          </div>
          <div>
            <span>预览哈希</span><strong>{{ page.shortHash(page.detail.previewHash) }}</strong>
          </div>
          <div>
            <span>执行结果</span
            ><strong
              >成功 {{ page.detail.succeededItems }} / 跳过 {{ page.detail.skippedItems }} / 失败
              {{ page.detail.failedItems }}</strong
            >
          </div>
          <div class="wide">
            <span>申请原因</span><strong>{{ page.detail.reason }}</strong>
          </div>
          <div class="wide">
            <span>备份证据</span><strong>{{ page.detail.backupEvidence }}</strong>
          </div>
        </section>

        <section>
          <h3>执行明细</h3>
          <V2Table
            :schema="v2TableSchemas.dataGovernance.items"
            :data="page.detail.items"
            max-height="360"
            scrollbar-always-on
          >
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.items.columns[0]"
              prop="sequence"
            />
            <V2TableColumn :definition="v2TableSchemas.dataGovernance.items.columns[1]">
              <template #default="{ row }">{{
                row.entityType === 'exchange_rate_run'
                  ? '汇率运行'
                  : page.recycleEntityLabel(row.entityType)
              }}</template>
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.items.columns[2]"
              prop="safeLabel"
            />
            <V2TableColumn :definition="v2TableSchemas.dataGovernance.items.columns[3]">
              <template #default="{ row }"
                ><el-tag :type="page.getGovernanceItemStatusMeta(row.status).type" effect="plain">{{
                  page.getGovernanceItemStatusMeta(row.status).label
                }}</el-tag></template
              >
            </V2TableColumn>
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.items.columns[4]"
              prop="resultMessage"
              show-overflow-tooltip
            />
            <V2TableColumn :definition="v2TableSchemas.dataGovernance.items.columns[5]">
              <template #default="{ row }">{{ row.resultAuditLogId ?? '—' }}</template>
            </V2TableColumn>
          </V2Table>
        </section>

        <section>
          <h3>执行检查点</h3>
          <V2Table
            :schema="v2TableSchemas.dataGovernance.checkpoints"
            :data="page.detail.checkpoints"
            max-height="260"
            scrollbar-always-on
          >
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[0]"
              prop="batchNo"
            />
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[1]"
              prop="status"
            />
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[2]"
              prop="attemptedItems"
            />
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[3]"
              prop="succeededItems"
            />
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[4]"
              prop="skippedItems"
            />
            <V2TableColumn
              :definition="v2TableSchemas.dataGovernance.checkpoints.columns[5]"
              prop="failedItems"
            />
            <V2TableColumn :definition="v2TableSchemas.dataGovernance.checkpoints.columns[6]">
              <template #default="{ row }">{{
                page.formatGovernanceDate(row.completedAt)
              }}</template>
            </V2TableColumn>
          </V2Table>
        </section>
      </div>
    </V2AsyncRegion>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ page: DataGovernancePage }>();
const restoreFormRef = ref<FormInstance>();
const cleanupFormRef = ref<FormInstance>();
const decisionFormRef = ref<FormInstance>();

function beforeRestoreClose(done: () => void) {
  props.page.beforeClose(props.page.restoreDirty, done);
}

function beforeCleanupClose(done: () => void) {
  props.page.beforeClose(props.page.cleanupDirty, done);
}

function beforeDecisionClose(done: () => void) {
  props.page.beforeClose(props.page.decisionDirty, done);
}
</script>

<style scoped>
.v2-governance-drawer,
.v2-governance-detail {
  display: grid;
  gap: 16px;
}

.v2-governance-selection-summary,
.v2-governance-decision-summary,
.v2-governance-detail-summary {
  padding: 14px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface-soft);
}

.v2-governance-selection-summary > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.v2-governance-decision-summary,
.v2-governance-detail-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.v2-governance-decision-summary > div,
.v2-governance-detail-summary > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.v2-governance-decision-summary .wide,
.v2-governance-detail-summary .wide {
  grid-column: 1 / -1;
}

.v2-governance-decision-summary span,
.v2-governance-detail-summary span,
.v2-governance-selection-summary span {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-governance-decision-summary strong,
.v2-governance-detail-summary strong {
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
}

.v2-governance-detail section {
  display: grid;
  gap: 10px;
}

.v2-governance-detail h3 {
  margin: 0;
  color: var(--v2-text);
  font-size: 14px;
}

@media (max-width: 560px) {
  .v2-governance-decision-summary,
  .v2-governance-detail-summary {
    grid-template-columns: 1fr;
  }

  .v2-governance-decision-summary .wide,
  .v2-governance-detail-summary .wide {
    grid-column: auto;
  }
}
</style>
