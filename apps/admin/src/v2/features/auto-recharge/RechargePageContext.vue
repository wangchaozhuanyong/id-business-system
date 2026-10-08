<template>
  <V2PageContext
    :description="
      directMode
        ? '网页直连当前电脑的比特浏览器，无需额外连接器；首次使用请打开连接说明，完成本地接口设置。'
        : '使用本机比特浏览器核实账号与当前套餐；取得官网开通或升级报价后，等待你确认本次付款。'
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
        directMode ? '比特浏览器直连设置' : '本机充值助手设置'
      }}</AppButton>
      <span v-if="!directMode">核价后人工确认付款</span>
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
  directMode?: boolean;
}>();
defineEmits<{ settings: []; history: [] }>();
</script>
