<template>
  <el-form
    inline
    label-position="left"
    require-asterisk-position="right"
    @submit.prevent="$emit('search')"
  >
    <el-form-item label="搜索"
      ><V2SearchInput
        v-model="model.keyword"
        draft-key="proxy-pool:ProxyPoolFilters:model.keyword"
        clearable
        placeholder="代理地址、国家代码或备注"
        @search="$emit('search')"
    /></el-form-item>
    <el-form-item label="国家"
      ><el-select
        v-model="model.countryCode"
        clearable
        filterable
        aria-label="筛选代理国家"
        placeholder="全部国家"
        ><el-option
          v-for="[code, label] in proxyCountries"
          :key="code"
          :value="code"
          :label="label" /></el-select
    ></el-form-item>
    <el-form-item label="IP 属性"
      ><el-select v-model="model.kind" clearable aria-label="筛选代理属性" placeholder="全部属性"
        ><el-option
          v-for="(label, key) in proxyKindLabels"
          :key="key"
          :value="key"
          :label="label" /></el-select
    ></el-form-item>
    <el-form-item label="状态"
      ><el-select v-model="model.status" clearable aria-label="筛选代理状态" placeholder="全部状态"
        ><el-option label="启用" value="active" /><el-option
          label="停用"
          value="disabled" /></el-select
    ></el-form-item>
    <el-form-item label="排序"
      ><el-select v-model="model.sortOrder" aria-label="代理排序"
        ><el-option label="更新从新到旧" value="desc" /><el-option
          label="更新从旧到新"
          value="asc" /></el-select
    ></el-form-item>
  </el-form>
</template>
<script setup lang="ts">
import V2SearchInput from '@/v2/components/V2SearchInput.vue';
import { proxyCountries, proxyKindLabels } from './options';
const model = defineModel<{
  keyword: string;
  countryCode: string;
  kind: string;
  status: string;
  sortOrder: string;
}>({ required: true });
defineEmits<{ search: [] }>();
</script>
