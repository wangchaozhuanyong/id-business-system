<template>
  <template v-if="!page.editingItem">
    <el-divider content-position="left">ID 采购入账</el-divider>
    <el-alert
      v-if="page.purchaseSourcesError"
      type="error"
      :title="`付款来源加载失败：${page.purchaseSourcesError}`"
      :closable="false"
      show-icon
    >
      <template #default>
        <AppButton variant="ghost" @click="page.loadPurchaseSources">重新加载</AppButton>
      </template>
    </el-alert>
    <div class="v2-record-form-grid">
      <el-form-item label="采购币种" prop="purchaseCurrency">
        <el-select v-model="page.form.purchaseCurrency" @change="page.handlePurchaseCurrencyChange">
          <el-option label="人民币 CNY" value="CNY" />
          <el-option label="马币 MYR" value="MYR" />
          <el-option label="美元 USD" value="USD" />
          <el-option label="USDT" value="USDT" />
        </el-select>
      </el-form-item>
      <el-form-item label="原币金额" prop="purchaseOriginalAmount">
        <el-input
          v-model="page.form.purchaseOriginalAmount"
          inputmode="decimal"
          placeholder="实际支付金额"
        />
      </el-form-item>
    </div>
    <el-form-item label="付款来源" prop="purchaseSourceId">
      <el-select
        v-model="page.form.purchaseSourceId"
        filterable
        :loading="page.purchaseSourcesLoading"
        placeholder="选择资金账户或供应商预存钱包"
      >
        <el-option
          v-for="option in page.purchaseSourceOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
    </el-form-item>
    <div class="v2-record-form-grid">
      <el-form-item label="采购时间" prop="purchasedAt">
        <el-input v-model="page.form.purchasedAt" type="datetime-local" />
      </el-form-item>
      <el-form-item :label="page.form.purchaseCurrency === 'CNY' ? '人民币成本' : '预计人民币成本'">
        <el-input :model-value="page.purchaseCostPreview || '系统按交易汇率计算'" readonly />
      </el-form-item>
    </div>
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
