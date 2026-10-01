<template>
  <V2FormDrawer
    retain-draft
    :model-value="true"
    title="批量导入代理 IP"
    description="每行依次填写国家、IP 链接、IP 属性、备注1、备注2。"
    confirm-text="导入代理 IP"
    size="min(720px, 96vw)"
    :confirm-loading="importing"
    :dirty="Boolean(importText.trim())"
    @update:model-value="!$event && $emit('close')"
    @confirm="importProxies"
  >
    <el-form label-position="left" label-width="110px" require-asterisk-position="right">
      <el-form-item label="提取代理协议" required>
        <el-select v-model="importProtocol" aria-label="批量提取代理协议">
          <el-option
            v-for="[value, label] in Object.entries(proxyProtocolLabels)"
            :key="value"
            :value="value"
            :label="label"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="代理 IP 资料" required
        ><el-input
          v-model="importText"
          type="textarea"
          :rows="12"
          :maxlength="210000"
          autocomplete="off"
          aria-label="粘贴代理 IP 资料"
          placeholder="美国    https://proxy.example.net/get-ip    动态住宅    备注1    备注2"
      /></el-form-item>
    </el-form>
    <p class="bank-recharge-form-note">
      提取链接使用上方协议；直连链接按链接自身协议保存。列之间可用 Tab 或空格；备注含空格时请用 Tab
      分列。空备注可用 - 占位。每次最多 100 条。
    </p>
    <p v-if="importError" class="bank-recharge-error" role="alert">{{ importError }}</p>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { getApiErrorMessage } from '@/api/client';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { rechargeProxyApi } from './recharge-proxy-api';
import { parseRechargeProxyImport } from './recharge-proxy-import';
import { proxyProtocolLabels, type ProxyProtocol } from './recharge-proxy-options';
const emit = defineEmits<{ close: []; imported: [count: number] }>();
const { importText, importProtocol } = useV2SessionDraft('recharge-proxy-import', () => ({
  importText: ref(''),
  importProtocol: ref<ProxyProtocol>('http')
}));
const importing = ref(false);
const importError = ref('');
async function importProxies() {
  if (importing.value) return;
  try {
    const rows = parseRechargeProxyImport(importText.value, importProtocol.value);
    importing.value = true;
    importError.value = '';
    const result = await rechargeProxyApi.importMany(rows);
    importText.value = '';
    emit('imported', result.imported);
  } catch (cause) {
    importError.value = getApiErrorMessage(cause);
  } finally {
    importing.value = false;
  }
}
</script>
