<template>
  <el-form-item label="客户" prop="customerId">
    <V2CustomerRemoteSelect
      v-model="form.customerId"
      :customers="customers"
      :keyword="customerKeyword"
      :searching="customerSearching"
      :remote-method="(keyword: string) => $emit('search-customers', keyword)"
      :disabled="!order?.operations.canEditCore"
    />
  </el-form-item>

  <el-form-item label="ID 来源">
    <el-radio-group
      v-model="form.accountSource"
      :disabled="!order?.operations.canEditCore"
      aria-label="ID 来源"
    >
      <el-radio-button value="inventory">库存 ID</el-radio-button>
      <el-radio-button value="customer_owned">客户已购 ID</el-radio-button>
    </el-radio-group>
  </el-form-item>

  <el-form-item label="业务" prop="serviceOptionId">
    <el-select
      v-model="form.serviceOptionId"
      filterable
      :disabled="!order?.operations.canEditCore"
      placeholder="选择业务"
    >
      <el-option
        v-for="service in services"
        :key="service.id"
        :label="service.label"
        :value="service.id"
      />
    </el-select>
  </el-form-item>

  <el-form-item label="消耗余额" prop="balanceAmount">
    <el-input
      v-model="form.balanceAmount"
      inputmode="decimal"
      maxlength="19"
      :disabled="!order?.operations.canEditCore"
    />
  </el-form-item>

  <el-form-item label="使用 ID" prop="accountId">
    <el-select
      v-model="form.accountId"
      filterable
      :loading="matchingLoading"
      :disabled="!order?.operations.canEditCore"
      placeholder="选择匹配 ID"
      :remote="form.accountSource === 'customer_owned'"
      :reserve-keyword="form.accountSource === 'customer_owned'"
      :remote-method="(keyword: string) => $emit('search-candidates', keyword)"
    >
      <el-option
        v-for="candidate in accounts"
        :key="candidate.id"
        :label="candidate.label"
        :value="candidate.id"
      />
    </el-select>
    <span v-if="matchingError" class="v2-order-edit-error">{{ matchingError }}</span>
  </el-form-item>

  <el-form-item v-if="form.accountSource === 'inventory'" label="ID 处理方式">
    <div class="v2-order-edit-disposition">
      <el-radio-group v-model="form.accountDisposition" :disabled="!order?.operations.canEditCore">
        <el-radio value="retained">保留 ID</el-radio>
        <el-radio value="sold">卖出 ID</el-radio>
      </el-radio-group>
      <small v-if="form.accountDisposition === 'sold'"
        >将计入当前 ID 购买成本，并记录首次销售归属。</small
      >
      <small v-else>不计 ID 购买成本，ID 仍可继续使用。</small>
    </div>
  </el-form-item>
  <el-form-item v-else label="本单 ID 成本">
    <div class="v2-order-edit-disposition">
      <strong>¥0</strong>
      <small>保留原销售订单与客户归属，仅按当前业务建立锁。</small>
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
import V2CustomerRemoteSelect from '@/v2/features/order-entry/components/V2CustomerRemoteSelect.vue';
import type { V2Order, V2OrderEntryCustomer } from '../contracts';
import type { OrderEditForm } from './order-edit-form';

defineProps<{
  form: OrderEditForm;
  order: V2Order | null;
  customers: V2OrderEntryCustomer[];
  customerKeyword: string;
  customerSearching: boolean;
  services: Array<{ id: string; label: string }>;
  accounts: Array<{ id: string; label: string }>;
  matchingLoading: boolean;
  matchingError: string;
}>();

defineEmits<{
  'search-customers': [keyword: string];
  'search-candidates': [keyword: string];
}>();
</script>
