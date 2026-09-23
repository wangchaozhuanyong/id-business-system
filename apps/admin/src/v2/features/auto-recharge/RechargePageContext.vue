<template>
  <V2PageContext
    description="使用授权 JSON 或账号密码登录本机比特浏览器；自动充值按金额上限执行，需要真人或银行验证时保留原窗口等待处理。"
  >
    <template #status>
      <span class="recharge-connector-status" :data-status="connectorStatus">{{
        connectorMessage
      }}</span>
    </template>
    <template #actions>
      <el-button @click="$emit('settings')">代理 IP 与窗口设置</el-button>
      <el-button @click="$emit('history')">最近执行记录</el-button>
    </template>
  </V2PageContext>
</template>

<script setup lang="ts">
import V2PageContext from '@/v2/components/V2PageContext.vue';
defineProps<{ connectorStatus: string; connectorMessage: string }>();
defineEmits<{ settings: []; history: [] }>();
</script>
