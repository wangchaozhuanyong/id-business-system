<template>
  <article v-for="item in items" :key="item.supplier.id" class="v2-records-mobile-item">
    <header>
      <div>
        <strong v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '供应商']">
          {{ item.supplier.name }}
        </strong>
        <span v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '资金状态']">
          {{ item.initialized ? '资金账户已初始化' : '资金账户未初始化' }}
        </span>
      </div>
      <el-tag
        v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '资金状态']"
        class="v2-status-tag"
        :type="!item.initialized ? 'info' : item.isNegative ? 'danger' : 'success'"
        effect="plain"
      >
        {{ !item.initialized ? '未初始化' : item.isNegative ? '余额为负' : '正常' }}
      </el-tag>
    </header>
    <dl>
      <div
        v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '当前人民币余额']"
      >
        <dt>当前余额</dt>
        <dd :class="{ 'is-negative': item.isNegative }">
          {{ item.currentBalanceCny === null ? '—' : `¥${formatDecimal(item.currentBalanceCny)}` }}
        </dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '累计有效付款']">
        <dt>有效付款</dt>
        <dd>¥{{ formatDecimal(item.paymentsCny) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '累计加卡扣款']">
        <dt>加卡扣款</dt>
        <dd>¥{{ formatDecimal(item.topupDeductionsCny) }}</dd>
      </div>
      <div v-v2-column-visibility="[v2TableSchemas.topupRecords.supplierFunds.id, '期初及净调账']">
        <dt>期初及净调账</dt>
        <dd>{{ formatSignedCurrency(item.netAdjustmentsCny) }}</dd>
      </div>
    </dl>
    <footer>
      <AppButton size="small" variant="ghost" @click="emit('details', item)"> 查看明细 </AppButton>
      <template v-if="canManage">
        <AppButton
          v-if="!item.initialized"
          size="small"
          @click="emit('mutation', item, 'initialize')"
        >
          初始化
        </AppButton>
        <template v-else>
          <AppButton size="small" variant="soft" @click="emit('mutation', item, 'payment')">
            记录付款
          </AppButton>
          <AppButton size="small" variant="ghost" @click="emit('mutation', item, 'adjust')">
            调整
          </AppButton>
        </template>
      </template>
    </footer>
  </article>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { V2TopupSupplierFundItem } from '../contracts';
import {
  formatSupplierFundDecimal as formatDecimal,
  formatSupplierFundSignedCurrency as formatSignedCurrency
} from '../topup-supplier-fund-format';

defineProps<{ items: V2TopupSupplierFundItem[]; canManage: boolean }>();
const emit = defineEmits<{
  details: [item: V2TopupSupplierFundItem];
  mutation: [item: V2TopupSupplierFundItem, mode: 'initialize' | 'payment' | 'adjust'];
}>();
</script>
