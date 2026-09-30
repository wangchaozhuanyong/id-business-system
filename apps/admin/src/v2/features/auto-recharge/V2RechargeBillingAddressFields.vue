<template>
  <el-form-item v-if="operationMode === 'server_payment'" label="账单地址来源" required>
    <el-radio-group v-model="source">
      <el-radio-button value="library">地址库</el-radio-button>
      <el-radio-button value="manual">临时手填</el-radio-button>
    </el-radio-group>
  </el-form-item>
  <el-form-item
    v-if="operationMode !== 'server_payment' || source === 'library'"
    label="地址库"
    required
  >
    <el-select
      v-model="addressId"
      aria-label="选择真实账单地址"
      filterable
      :loading="loading"
      placeholder="选择与银行卡相符的账单地址"
      no-data-text="没有可用账单地址"
    >
      <el-option
        v-for="address in addresses"
        :key="address.id"
        :label="address.line1"
        :value="address.id"
      />
    </el-select>
  </el-form-item>
  <template v-if="operationMode === 'server_payment' && source === 'manual'">
    <el-form-item label="账单国家" prop="country" required
      ><el-input v-model="details.country" maxlength="2" placeholder="两位国家代码，如 US"
    /></el-form-item>
    <el-form-item label="街道地址" prop="line1" required
      ><el-input v-model="details.line1" maxlength="180" placeholder="填写与银行卡相符的街道地址"
    /></el-form-item>
    <el-form-item label="补充地址" prop="line2"
      ><el-input v-model="details.line2" maxlength="180" placeholder="门牌、楼层等（选填）"
    /></el-form-item>
    <el-form-item label="城市" prop="city" required
      ><el-input v-model="details.city" maxlength="120"
    /></el-form-item>
    <el-form-item label="州／省" prop="state"
      ><el-input v-model="details.state" maxlength="120"
    /></el-form-item>
    <el-form-item label="邮编" prop="postal_code" required
      ><el-input v-model="details.postal_code" maxlength="20"
    /></el-form-item>
  </template>
  <p v-if="source === 'library' && error" class="recharge-error" role="alert">
    {{ error }} <el-button link type="primary" @click="$emit('retry')">重试</el-button>
  </p>
  <p v-else-if="source === 'library' && !addresses.length" class="recharge-note" role="status">
    暂无可用地址，请先到“地址管理”核对或启用地址。
  </p>
</template>

<script setup lang="ts">
import type { V2RechargeAddress, V2RechargeDetails } from './contracts';

const details = defineModel<V2RechargeDetails>({ required: true });
const source = defineModel<'library' | 'manual'>('source', { required: true });
const addressId = defineModel<string>('addressId', { required: true });
defineProps<{
  operationMode: 'server_payment' | 'payment' | 'open_browser';
  addresses: V2RechargeAddress[];
  loading: boolean;
  error: string;
}>();
defineEmits<{ retry: [] }>();
</script>
