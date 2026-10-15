<template>
  <el-form-item class="recharge-full-row" label="账单姓名" prop="name" required>
    <el-input
      v-model="details.name"
      :validate-event="validateEvent !== false"
      readonly
      maxlength="120"
      name="recharge-entry-name"
      placeholder="输入或选择银行卡后，自动填写账单姓名"
      autocomplete="off"
    />
    <p v-if="nameLoading" role="status">正在匹配账单姓名…</p>
    <p v-else-if="nameError" class="recharge-error" role="alert">
      {{ nameError }} <AppButton size="small" @click="nameMatch?.retry()">重试</AppButton>
    </p>
    <p v-else-if="nameConfirmed" class="recharge-note">已回填这张银行卡的绑定账单姓名</p>
    <p v-else class="recharge-note">新卡自动生成英文账单姓名；再次使用同一张卡时保留原姓名。</p>
  </el-form-item>
  <el-form-item class="recharge-address-select recharge-full-row" label="地址库" required>
    <div class="recharge-billing-address-row">
      <el-select
        v-model="addressId"
        aria-label="选择真实账单地址"
        name="recharge-billing-entry"
        autocomplete="off"
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
      <AppButton
        variant="soft"
        :loading="generating"
        :disabled="!canGenerate || generating"
        @click="$emit('generate')"
        >一键生成并使用</AppButton
      >
    </div>
  </el-form-item>
  <p v-if="generationError" class="recharge-error" role="alert">{{ generationError }}</p>
  <p v-if="source === 'library' && error" class="recharge-error" role="alert">
    {{ error }} <AppButton link variant="primary" @click="$emit('retry')">重试</AppButton>
  </p>
  <p v-else-if="addressBound && !selectedAddress" class="recharge-error" role="alert">
    这张卡的绑定地址不可用，请到地址管理核对原地址；系统不会自动替换。
  </p>
  <p v-else-if="source === 'library' && !addresses.length" class="recharge-note" role="status">
    暂无可用地址，输入银行卡后自动生成，也可点击“一键生成并使用”。
  </p>
  <p v-if="addressBound && selectedAddress" class="recharge-note">
    这张卡已有绑定账单地址，系统沿用原资料。
  </p>
  <p class="recharge-note">生成地址为模板，请在付款前核对。地址不会改变代理国家或付款币种。</p>
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
import { computed, type Ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2RechargeAddress, V2RechargeDetails } from './contracts';

const details = defineModel<V2RechargeDetails>({ required: true });
const source = defineModel<'library' | 'manual'>('source', { required: true });
const addressId = defineModel<string>('addressId', { required: true });
const props = defineProps<{
  validateEvent?: boolean;
  nameMatch?: {
    loading: Ref<boolean>;
    error: Ref<string>;
    confirmed: Ref<boolean>;
    retry: () => Promise<void>;
  };
  operationMode: 'payment' | 'open_browser';
  addresses: V2RechargeAddress[];
  selectedAddress?: V2RechargeAddress;
  loading: boolean;
  error: string;
  generating?: boolean;
  generationError?: string;
  canGenerate?: boolean;
  addressBound?: boolean;
}>();
const nameLoading = computed(() => props.nameMatch?.loading.value ?? false);
const nameError = computed(() => props.nameMatch?.error.value ?? '');
const nameConfirmed = computed(() => props.nameMatch?.confirmed.value ?? false);
defineEmits<{ retry: []; select: []; generate: [] }>();
</script>

<style scoped>
.recharge-billing-address-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--v2-layout-control-gap);
  width: 100%;
  min-width: 0;
}
.recharge-billing-address-row > .el-select {
  flex: 1 1 220px;
  min-width: 0;
}
.recharge-billing-address-row > .app-button {
  flex-shrink: 0;
}
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
