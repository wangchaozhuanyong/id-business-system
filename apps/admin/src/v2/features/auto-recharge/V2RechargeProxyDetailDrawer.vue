<template>
  <el-drawer
    :model-value="true"
    title="代理 IP 详细"
    size="min(680px, 96vw)"
    destroy-on-close
    @close="$emit('close')"
  >
    <p v-if="loading">正在读取代理资料…</p>
    <p v-if="error" class="bank-recharge-error" role="alert">
      {{ error }} <AppButton size="small" @click="load">重试</AppButton>
    </p>
    <el-descriptions v-if="detail" :column="1" label-width="96px" border>
      <el-descriptions-item label="国家">{{
        proxyCountryLabel(detail.countryCode)
      }}</el-descriptions-item>
      <el-descriptions-item label="IP 属性">{{
        proxyKindLabels[detail.kind]
      }}</el-descriptions-item>
      <el-descriptions-item label="IP 链接"
        ><span class="proxy-detail-url">{{
          detail.url || '已清除，请重新查看'
        }}</span></el-descriptions-item
      >
      <el-descriptions-item label="代理协议">{{
        proxyProtocolLabel(detail.protocol)
      }}</el-descriptions-item>
      <el-descriptions-item label="状态">{{
        detail.status === 'active' ? '启用' : '停用'
      }}</el-descriptions-item>
      <el-descriptions-item label="备注1">{{ detail.remark1 || '—' }}</el-descriptions-item>
      <el-descriptions-item label="备注2">{{ detail.remark2 || '—' }}</el-descriptions-item>
    </el-descriptions>
    <p v-if="detail && !detail.url">
      <AppButton size="small" @click="load">重新查看链接</AppButton>
    </p>
  </el-drawer>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { rechargeProxyApi, type RechargeProxyDetail } from './recharge-proxy-api';
import { proxyCountryLabel, proxyKindLabels, proxyProtocolLabel } from './recharge-proxy-options';

const props = defineProps<{ id: string }>();
defineEmits<{ close: [] }>();
const detail = ref<RechargeProxyDetail | null>(null);
const loading = ref(false);
const error = ref('');
let mounted = true;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const value = await rechargeProxyApi.detail(props.id);
    if (!mounted) return;
    detail.value = value;
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (detail.value) detail.value = { ...detail.value, url: '' };
    }, 60_000);
  } catch (cause) {
    if (mounted) error.value = getApiErrorMessage(cause);
  } finally {
    if (mounted) loading.value = false;
  }
}
onMounted(() => {
  void load();
});
onUnmounted(() => {
  mounted = false;
  if (clearTimer) clearTimeout(clearTimer);
  detail.value = null;
});
</script>

<style scoped>
.proxy-detail-url {
  overflow-wrap: anywhere;
}
</style>
