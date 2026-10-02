<template>
  <V2FormDrawer
    v-model="recovery.visible"
    title="恢复修改前的内容"
    eyebrow="普通资料更正"
    description="勾选需要改回的项目，核对后确认。恢复成功会保存一条新的操作记录。"
    size="min(680px, 94vw)"
    confirm-text="确认恢复所选项目"
    :confirm-loading="recovery.submitting"
    :confirm-disabled-reason="recovery.disabledReason"
    :dirty="recovery.dirty"
    @confirm="recovery.submit"
  >
    <V2AsyncRegion
      :phase="recovery.previewPhase"
      :previous-data="recovery.previewPreviousData"
      :error="recovery.previewError"
      skeleton="form"
      loading-title="正在核对当前资料"
      error-title="资料核对失败"
      @retry="recovery.refreshPreview"
    >
      <template v-if="recovery.preview">
        <p>{{ recovery.preview.objectLabel }}</p>
        <el-alert
          v-if="recovery.preview.blockers.length"
          type="warning"
          :title="recovery.preview.blockers.join(' ')"
          :closable="false"
          show-icon
        />
        <el-form
          class="v2-horizontal-form"
          :model="recovery.form"
          label-position="left"
          label-width="88px"
          require-asterisk-position="right"
        >
          <el-form-item label="恢复项目" required>
            <div class="v2-audit-restore-fields" role="group" aria-label="恢复项目">
              <div v-for="field in recovery.preview.fields" :key="field.key">
                <el-checkbox
                  :model-value="recovery.form.fields.includes(field.key)"
                  :disabled="
                    recovery.submitting ||
                    !recovery.preview.canRestore ||
                    Boolean(field.blockedReason)
                  "
                  @change="recovery.selectField(field.key, $event === true)"
                  >{{ field.label }}</el-checkbox
                >
                <dl class="v2-audit-restore-values">
                  <div>
                    <dt>现在的内容</dt>
                    <dd>{{ displayValue(field.currentValue) }}</dd>
                  </div>
                  <div>
                    <dt>准备改回</dt>
                    <dd>{{ displayValue(field.restoreValue) }}</dd>
                  </div>
                </dl>
                <p v-if="field.blockedReason">{{ field.blockedReason }}</p>
              </div>
            </div>
          </el-form-item>
          <el-form-item label="恢复原因" required>
            <el-input
              v-model="recovery.form.reason"
              aria-label="恢复原因"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="例如：录入时将客户名称填错，现按原资料更正"
              :disabled="recovery.submitting"
            />
          </el-form-item>
        </el-form>
      </template>
    </V2AsyncRegion>
    <el-alert
      v-if="recovery.submitError"
      type="error"
      :title="recovery.submitError"
      :closable="false"
      show-icon
    />
  </V2FormDrawer>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { auditChangeValue } from '../audit-log-changes';
import type { useAuditFieldRestore } from '../useAuditFieldRestore';

defineProps<{ recovery: UnwrapNestedRefs<ReturnType<typeof useAuditFieldRestore>> }>();
function displayValue(value: string | number | null) {
  return auditChangeValue(value, '');
}
</script>

<style scoped>
.v2-audit-restore-fields {
  display: grid;
  gap: var(--v2-layout-panel-gap);
  min-width: 0;
  width: 100%;
}
.v2-audit-restore-values {
  display: grid;
  gap: 8px;
  margin: 0;
}
.v2-audit-restore-values > div {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
}
.v2-audit-restore-values dt,
.v2-audit-restore-values dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.v2-audit-restore-values dt {
  color: var(--v2-text-soft);
}
</style>
