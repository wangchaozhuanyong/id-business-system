<template>
  <el-form-item class="recharge-address-select recharge-full-row" label="地址库" required>
    <el-select
      v-model="addressId"
      aria-label="选择真实账单地址"
      filterable
      :loading="loading"
      placeholder="选择与银行卡相符的账单地址"
      no-data-text="没有可用账单地址"
      @change="$emit('select')"
    >
      <el-option
        v-for="address in addresses"
        :key="address.id"
        :label="address.line1"
        :value="address.id"
      />
    </el-select>
  </el-form-item>
  <p v-if="source === 'library' && error" class="recharge-error" role="alert">
    {{ error }} <AppButton link variant="primary" @click="$emit('retry')">重试</AppButton>
  </p>
  <p v-else-if="source === 'library' && !addresses.length" class="recharge-note" role="status">
    暂无可用地址，请先到“地址管理”核对或启用地址。
  </p>
  <dl v-if="selectedAddress" class="recharge-fixed-address">
    <div>
      <dt>国家</dt>
      <dd>{{ selectedAddress.country }}</dd>
    </div>
    <div>
      <dt>街道</dt>
      <dd>{{ selectedAddress.line1 }}</dd>
    </div>
    <div>
      <dt>城市</dt>
      <dd>{{ selectedAddress.city }}</dd>
    </div>
    <div>
      <dt>州与邮编</dt>
      <dd>{{ selectedAddress.state }} {{ selectedAddress.postalCode }}</dd>
    </div>
  </dl>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RechargeAddress, V2RechargeDetails } from './contracts';

defineModel<V2RechargeDetails>({ required: true });
const source = defineModel<'library' | 'manual'>('source', { required: true });
const addressId = defineModel<string>('addressId', { required: true });
defineProps<{
  operationMode: 'payment' | 'open_browser';
  addresses: V2RechargeAddress[];
  selectedAddress?: V2RechargeAddress;
  loading: boolean;
  error: string;
}>();
defineEmits<{ retry: []; select: [] }>();
</script>

<style scoped>
.recharge-fixed-address {
  grid-column: 1 / -1;
  min-width: 0;
  display: grid;
  grid-template-columns: 0.6fr 2fr 1fr 1.2fr;
  gap: 6px 16px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.6;
}
.recharge-fixed-address > div {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
}
@container recharge-entry (max-width: 740px) {
  .recharge-fixed-address {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.recharge-fixed-address dt {
  color: var(--el-text-color-secondary);
}
.recharge-fixed-address dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .recharge-fixed-address {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    margin-left: 0;
  }
  .recharge-fixed-address > div {
    grid-template-columns: 64px minmax(0, 1fr);
  }
}
</style>
