<template>
  <V2ConfirmDialog
    v-model="archive.visible"
    :title="archive.mode === 'archive' ? '归档所选订单' : '恢复归档订单'"
    message=""
    width="min(620px, 94vw)"
    :confirm-text="
      archive.failures.length
        ? '重试未完成订单'
        : archive.mode === 'archive'
          ? '确认归档'
          : '确认恢复'
    "
    :confirm-loading="archive.saving"
    :confirm-disabled-reason="archive.disabledReason"
    @confirm="submit"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="仅调整订单列表的归档状态。保留全部账务、余额记录和 ID 来源，不清空资金；订单状态和金额保持原样。"
    />
    <ul aria-label="本次确认订单">
      <li v-for="target in archive.form.targets" :key="target.id">
        {{ target.orderNo }}
        <span v-if="archive.completedIds.has(target.id)"> · 已完成</span>
        <span v-else-if="failureFor(target.id)" role="alert"> · {{ failureFor(target.id) }}</span>
      </li>
    </ul>
    <el-form
      ref="formRef"
      :model="archive.form"
      :rules="rules"
      :disabled="archive.saving"
      class="v2-horizontal-form"
      label-position="left"
      label-width="96px"
      require-asterisk-position="right"
      scroll-to-error
    >
      <el-form-item label="操作原因" prop="reason">
        <el-input
          v-model="archive.form.reason"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          placeholder="填写 2 至 500 个字符的归档或恢复原因"
        />
      </el-form-item>
    </el-form>
    <p v-if="archive.failures.length" role="status">
      已完成订单不会重复提交。未完成订单保留原资料版本；如资料已变化，请先重新核对版本。
    </p>
    <AppButton
      v-if="archive.failures.length"
      variant="ghost"
      :loading="archive.saving"
      @click="archive.recheckFailed"
      >重新核对未完成订单</AppButton
    >
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useOrderArchive } from '../useOrderArchive';

type ArchiveController = UnwrapNestedRefs<ReturnType<typeof useOrderArchive>>;
const props = defineProps<{ archive: ArchiveController }>();
const formRef = ref<FormInstance>();
const rules: FormRules = {
  reason: [
    {
      required: true,
      min: 2,
      max: 500,
      message: '操作原因必须为 2 至 500 个字符',
      transform: (value: string) => value.trim(),
      trigger: ['blur', 'change']
    }
  ]
};
function failureFor(id: string) {
  return props.archive.failures.find((failure) => failure.id === id)?.message ?? '';
}
async function submit() {
  if (await validateV2Form(formRef.value)) await props.archive.submit();
}
</script>
