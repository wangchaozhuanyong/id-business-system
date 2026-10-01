<template>
  <el-form
    class="recharge-proxy-filters"
    inline
    label-position="left"
    require-asterisk-position="right"
    @submit.prevent="$emit('search')"
  >
    <el-form-item label="搜索"
      ><el-input
        v-model="keyword"
        clearable
        placeholder="国家代码或备注"
        @keyup.enter="$emit('search')"
    /></el-form-item>
    <el-form-item label="国家">
      <el-select
        v-model="country"
        filterable
        clearable
        aria-label="筛选代理国家"
        placeholder="全部国家"
      >
        <el-option
          v-for="[code, label] in proxyCountries"
          :key="code"
          :value="code"
          :label="label"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="IP 属性">
      <el-select v-model="kind" clearable aria-label="筛选代理属性" placeholder="全部属性">
        <el-option
          v-for="[value, label] in kindOptions"
          :key="value"
          :value="value"
          :label="label"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="状态">
      <el-select v-model="status" aria-label="筛选代理状态" placeholder="全部状态">
        <el-option label="全部状态" value="" /><el-option label="启用" value="active" /><el-option
          label="停用"
          value="disabled"
        />
      </el-select>
    </el-form-item>
    <el-form-item><AppButton @click="$emit('search')">搜索</AppButton></el-form-item>
  </el-form>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { RechargeProxyItem } from './recharge-proxy-api';
import { proxyCountries, proxyKindLabels, type ProxyKind } from './recharge-proxy-options';

const keyword = defineModel<string>('keyword', { required: true });
const country = defineModel<string>('country', { required: true });
const kind = defineModel<ProxyKind | ''>('kind', { required: true });
const status = defineModel<RechargeProxyItem['status'] | ''>('status', { required: true });
const kindOptions = Object.entries(proxyKindLabels) as [ProxyKind, string][];

defineEmits<{ search: [] }>();
</script>
