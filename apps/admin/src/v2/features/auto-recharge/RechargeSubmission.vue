<template>
  <div v-if="operationMode !== 'open_browser'" class="recharge-authorization">
    <el-checkbox v-model="authorizeSinglePayment">
      我已核对银行卡真实姓名、账单地址和币种，授权本任务在付款安全上限内最多提交一次官网付款
    </el-checkbox>
    <p class="recharge-note">
      官网币种不一致、今日应付超过上限、税费或订单金额不明确时立即停止；不会换币种或重试付款。
    </p>
  </div>
  <div class="recharge-form-footer">
    <el-button
      v-if="operationMode === 'open_browser'"
      type="primary"
      :disabled="!canStartOpen"
      :loading="busy"
      @click="$emit('startOpen')"
    >
      打开比特浏览器并登录
    </el-button>
    <el-button v-else type="primary" :disabled="!canStart" :loading="busy" @click="$emit('start')">
      {{
        operationMode === 'server_payment' ? '在服务器执行本次充值' : '连接比特浏览器并执行本次充值'
      }}
    </el-button>
    <p class="recharge-note">
      {{
        operationMode === 'server_payment'
          ? '本次安全码仅传至服务器执行器内存；已保存的卡号加密存储，取用留审计。'
          : operationMode === 'open_browser'
            ? '登录资料只发送到本机连接器内存；登录成功后保留比特浏览器窗口供手动操作。'
            : '本次安全码只发送到本机连接器内存；已保存的卡号加密存储，取用留审计。'
      }}
    </p>
  </div>
</template>
<script setup lang="ts">
const authorizeSinglePayment = defineModel<boolean>({ required: true });
defineProps<{
  operationMode: 'server_payment' | 'payment' | 'open_browser';
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
