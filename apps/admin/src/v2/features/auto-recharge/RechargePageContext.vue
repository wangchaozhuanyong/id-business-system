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
        connectorMessage
      }}</span>
    </template>
    <template #actions>
      <AppButton variant="ghost" @click="$emit('settings')">{{
        serverMode ? '服务器默认代理' : directMode ? '比特浏览器直连设置' : '代理 IP 与窗口设置'
      }}</AppButton>
      <BitBrowserConnectionHelp v-if="directMode" />
      <AppButton variant="ghost" @click="$emit('history')">最近执行记录</AppButton>
    </template>
  </V2PageContext>
</template>

<script setup lang="ts">
import V2PageContext from '@/v2/components/V2PageContext.vue';
import AppButton from '@/components/ui/AppButton.vue';
import BitBrowserConnectionHelp from './BitBrowserConnectionHelp.vue';
defineProps<{
  connectorStatus: string;
  connectorMessage: string;
  serverMode?: boolean;
  directMode?: boolean;
}>();
defineEmits<{ settings: []; history: [] }>();
</script>
