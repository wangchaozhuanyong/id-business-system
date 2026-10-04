<template>
  <V2PageContext
    :description="
      serverMode
        ? '代理资料统一从代理 IP 管理选择，默认代理自动带入；服务器按本次选择与付款上限执行，结果不明时核对原订单。'
        : directMode
          ? '网页直连当前电脑的比特浏览器，无需额外连接器；首次使用请打开连接说明，完成本地接口设置。'
          : '使用授权 JSON 或账号密码登录本机比特浏览器；自动充值按金额上限执行，需要真人或银行验证时保留原窗口等待处理。'
    "
  >
    <template #status>
      <span class="recharge-connector-status" :data-status="connectorStatus">{{
        directMode && connectorStatus === 'unknown'
          ? '尚未检测比特浏览器本地接口'
          : connectorMessage
      }}</span>
    </template>
    <template #actions>
      <AppButton variant="ghost" @click="$emit('settings')">{{
        serverMode ? '服务器默认代理' : directMode ? '比特浏览器直连设置' : '代理 IP 与窗口设置'
      }}</AppButton>
      <label
        v-if="serverMode"
        class="recharge-manual-confirmation"
        title="开启后官网报价暂停，由本人确认付款；关闭后仍自动付款，官网强制验证仍需本人完成。最多等待 5 分钟。"
      >
        <span>付款前人工确认</span>
        <el-switch
          v-model="manualPaymentConfirmation"
          :disabled="locked"
          aria-label="付款前人工确认"
        />
      </label>
      <BitBrowserConnectionHelp v-if="directMode" />
      <AppButton variant="ghost" @click="$emit('history')">最近执行记录</AppButton>
    </template>
  </V2PageContext>
</template>

<script setup lang="ts">
import V2PageContext from '@/v2/components/V2PageContext.vue';
import AppButton from '@/components/ui/AppButton.vue';
import BitBrowserConnectionHelp from './BitBrowserConnectionHelp.vue';
import { useRechargeManualPaymentConfirmation } from './useRechargeManualPaymentConfirmation';
const manualPaymentConfirmation = useRechargeManualPaymentConfirmation();
defineProps<{
  connectorStatus: string;
  connectorMessage: string;
  serverMode?: boolean;
  directMode?: boolean;
  locked?: boolean;
}>();
defineEmits<{ settings: []; history: [] }>();
</script>
<style scoped>
.recharge-manual-confirmation {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
