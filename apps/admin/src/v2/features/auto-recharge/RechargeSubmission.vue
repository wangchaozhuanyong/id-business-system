<template>
  <div v-if="operationMode !== 'open_browser'" class="recharge-authorization">
    <el-checkbox v-model="authorizeSinglePayment">
      我已核对银行卡真实姓名与账单地址，授权本任务核实官网币种和金额后，经我人工确认最多提交一次官网付款
    </el-checkbox>
    <p class="recharge-note">
      官网币种不一致，或税费、今日应付、续费金额不明确时立即停止；付款前需人工确认，不会换币种或重复付款。
    </p>
  </div>
  <div class="recharge-form-footer">
    <AppButton
      v-if="operationMode === 'open_browser'"
      variant="primary"
      :disabled="!canStartOpen"
      :loading="busy"
      @click="$emit('startOpen')"
    >
      打开比特浏览器并登录
    </AppButton>
    <AppButton
      v-else
      variant="primary"
      :disabled="!canStart"
      :loading="busy"
      @click="$emit('start')"
    >
      在比特浏览器执行
    </AppButton>
    <p class="recharge-note">
      {{
        operationMode === 'open_browser'
          ? '网页直连比特浏览器，无需本机连接器；登录过程中请保留当前页面，成功后窗口保留供手动操作。'
          : '核价后等待人工确认。安全码仅用于本机本次执行；已保存的卡号加密存储，取用留审计。'
      }}
    </p>
  </div>
</template>
<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
const authorizeSinglePayment = defineModel<boolean>({ required: true });
defineProps<{
  operationMode: 'payment' | 'open_browser';
  canStart: boolean;
  canStartOpen: boolean;
  busy: boolean;
}>();
defineEmits<{ start: []; startOpen: [] }>();
</script>
<style scoped>
.recharge-note {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.7;
}
.recharge-authorization {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  margin: 8px 0;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.recharge-authorization :deep(.el-checkbox) {
  height: auto;
  white-space: normal;
}
.recharge-form-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  border-top: 1px solid var(--el-border-color);
  padding-top: 12px;
}
.recharge-form-footer .recharge-note {
  flex: 1 1 260px;
}
</style>
