<template>
  <el-form-item v-if="countries.length" label="代理国家" required>
    <el-select
      :model-value="countryCode"
      aria-label="选择代理国家"
      filterable
      placeholder="选择国家后查看该国代理"
      @update:model-value="$emit('update:countryCode', $event)"
    >
      <el-option
        v-for="code in countries"
        :key="code"
        :value="code"
        :label="proxyCountryLabel(code)"
      />
    </el-select>
  </el-form-item>
  <el-form-item v-if="countries.length" class="recharge-proxy-field" label="代理 IP" required>
    <el-select
      :model-value="proxyId"
      aria-label="选择代理 IP"
      filterable
      :disabled="!countryCode"
      :loading="loading"
      placeholder="仅显示所选国家的启用代理"
      @update:model-value="$emit('update:proxyId', $event)"
    >
      <el-option
        v-for="proxy in proxies"
        :key="proxy.id"
        :value="proxy.id"
        :label="`${proxyProtocolLabel(proxy.protocol)} · ${proxyKindLabels[proxy.kind]} · ${proxy.remark1 ? `${proxy.remark1} · ` : ''}${proxy.linkMask}`"
      />
    </el-select>
  </el-form-item>
  <p v-if="countries.length" class="recharge-note">
    代理资料来自代理 IP 管理，本次任务使用这里选中的条目。
    <el-button v-if="defaultProxyId" link type="primary" @click="$emit('useDefault')"
      >使用默认代理</el-button
    >
    <el-button v-if="proxyId" link type="primary" @click="detailId = proxyId"
      >查看完整链接</el-button
    >
    <router-link to="/v2/auto-recharge/proxies">管理代理</router-link>
  </p>
  <p v-else-if="!loading && !error" class="recharge-note">
    暂无启用代理，请先在<router-link to="/v2/auto-recharge/proxies">代理 IP 管理</router-link>新增。
  </p>
  <p v-if="error" class="recharge-error" role="alert">
    {{ error }} <el-button link type="primary" @click="$emit('retry')">重试</el-button>
  </p>
  <V2RechargeProxyDetailDrawer v-if="detailId" :id="detailId" @close="detailId = null" />
  <p v-if="loginCountryRestriction" class="recharge-error" role="alert">
    该账号首次登录国家是
    {{ proxyCountryLabel(loginCountryRestriction) }}，当前代理国家不一致，已限制登录。
  </p>
</template>

<script setup lang="ts">
import type { RechargeProxyItem } from './recharge-proxy-api';
import { ref } from 'vue';
import { proxyCountryLabel, proxyKindLabels, proxyProtocolLabel } from './recharge-proxy-options';
import V2RechargeProxyDetailDrawer from './V2RechargeProxyDetailDrawer.vue';

defineProps<{
  countryCode: string;
  proxyId: string;
  defaultProxyId?: string;
  countries: string[];
  loginCountryRestriction: string;
  proxies: RechargeProxyItem[];
  loading: boolean;
  error: string;
}>();
defineEmits<{
  'update:countryCode': [value: string];
  'update:proxyId': [value: string];
  retry: [];
  useDefault: [];
}>();
const detailId = ref<string | null>(null);
</script>
