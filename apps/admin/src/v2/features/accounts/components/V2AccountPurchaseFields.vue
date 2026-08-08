<template>
  <template v-if="!page.editingItem">
    <el-divider content-position="left">ID 采购入账</el-divider>
    <el-alert
      v-if="page.purchaseSourcesError"
      type="error"
      :title="`付款账户加载失败：${page.purchaseSourcesError}`"
      :closable="false"
      show-icon
    >
      <template #default>
        <AppButton variant="ghost" @click="page.loadPurchaseSources">重新加载</AppButton>
      </template>
    </el-alert>
    <div class="v2-record-form-grid">
      <el-form-item label="ID采购币种" prop="purchaseCurrency">
        <el-select v-model="page.form.purchaseCurrency" @change="page.handlePurchaseCurrencyChange">
          <el-option label="人民币 CNY" value="CNY" />
          <el-option label="马币 MYR" value="MYR" />
          <el-option label="美元 USD" value="USD" />
          <el-option label="USDT" value="USDT" />
        </el-select>
      </el-form-item>
      <el-form-item label="ID采购金额" prop="purchaseOriginalAmount">
        <el-input
          v-model="page.form.purchaseOriginalAmount"
          inputmode="decimal"
          placeholder="输入实际 ID 采购金额"
        />
      </el-form-item>
    </div>
    <el-form-item label="人民币成本">
      <div class="v2-account-purchase-calculated-field">
        <el-input
          :model-value="page.purchaseCostPreview"
          placeholder="系统按交易汇率自动计算"
          readonly
        />
        <small>根据 ID采购金额与交易汇率自动计算，无需手动填写。</small>
      </div>
    </el-form-item>
    <el-form-item label="付款账户" prop="purchaseSourceId">
      <el-select
        v-model="page.form.purchaseSourceId"
        filterable
        :loading="page.purchaseSourcesLoading"
        :placeholder="`选择 ${page.form.purchaseCurrency} 币种的资金账户`"
      >
        <el-option
          v-for="option in page.purchaseSourceOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="采购时间" prop="purchasedAt">
      <el-input v-model="page.form.purchasedAt" type="datetime-local" />
    </el-form-item>
    <div v-if="page.form.purchaseCurrency !== 'CNY'" class="v2-record-form-grid">
      <el-form-item label="手工汇率">
        <el-input
          v-model="page.form.purchaseFxRateToCny"
          inputmode="decimal"
          placeholder="留空则采集交易汇率"
        />
      </el-form-item>
      <el-form-item
        v-if="page.form.purchaseFxRateToCny"
        label="汇率原因"
        prop="purchaseManualRateReason"
      >
        <el-input
          v-model="page.form.purchaseManualRateReason"
          maxlength="200"
          placeholder="说明手工汇率来源"
        />
      </el-form-item>
    </div>
    <el-alert
      v-if="page.form.purchaseCurrency !== 'CNY' && !page.form.purchaseFxRateToCny"
      type="info"
      title="保存时会采集并锁定该交易时点汇率；汇率缺失或过期会拒绝入账。"
      :closable="false"
      show-icon
    />
  </template>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useAccountsPage } from '../useAccountsPage';

defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;
}>();
</script>

<style scoped>
.v2-account-purchase-calculated-field {
  display: grid;
  width: 100%;
  gap: 4px;
}

.v2-account-purchase-calculated-field small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.5;
}
</style>
