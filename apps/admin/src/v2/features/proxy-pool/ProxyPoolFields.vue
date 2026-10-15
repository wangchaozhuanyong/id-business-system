<template>
  <el-form-item label="国家" required
    ><el-select
      v-model="model.countryCode"
      filterable
      allow-create
      default-first-option
      aria-label="代理国家"
      placeholder="选择国家或输入两位代码"
      ><el-option
        v-for="[code, label] in proxyCountries"
        :key="code"
        :label="label"
        :value="code" /></el-select
  ></el-form-item>
  <el-form-item label="IP 属性" required
    ><el-select v-model="model.kind" aria-label="代理属性" placeholder="选择 IP 属性"
      ><el-option
        v-for="(label, key) in proxyKindLabels"
        :key="key"
        :value="key"
        :label="label" /></el-select
  ></el-form-item>
  <el-form-item label="连接方式" required
    ><el-select v-model="model.connectionMode" aria-label="代理连接方式"
      ><el-option label="代理地址（支持动态会话）" value="direct" /><el-option
        label="HTTPS 提取链接"
        value="extraction" /></el-select
  ></el-form-item>
  <el-form-item label="代理协议" required
    ><el-select v-model="model.protocol" aria-label="代理协议"
      ><el-option
        v-for="(label, key) in proxyProtocolLabels"
        :key="key"
        :value="key"
        :label="label" /></el-select
  ></el-form-item>
  <p>代理地址按链接自身协议保存；提取链接使用所选协议。</p>
  <el-form-item label="备注"
    ><el-input v-model="model.remark" type="textarea" :maxlength="1200" :rows="3"
  /></el-form-item>
</template>
<script setup lang="ts">
import {
  proxyCountries,
  proxyKindLabels,
  proxyProtocolLabels,
  type ProxyKind,
  type ProxyProtocol
} from './options';
export interface ProxyPoolForm {
  countryCode: string;
  kind: ProxyKind | '';
  connectionMode: 'direct' | 'extraction';
  protocol: ProxyProtocol;
  remark: string;
}
const model = defineModel<ProxyPoolForm>({ required: true });
</script>
