<template>
  <V2PageContext
    :description="
      directMode
        ? '网页直连当前电脑的比特浏览器，无需额外充值助手；Windows 与 Mac 首次配对接口后即可使用。执行期间请保留当前页面，核价后等待你确认付款。'
        : '网站在服务器运行；充值连接器负责控制当前电脑的比特浏览器。核实账号与官网报价后，等待你确认付款；无需本机 Docker。'
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
      <span>核价后人工确认付款</span>
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
