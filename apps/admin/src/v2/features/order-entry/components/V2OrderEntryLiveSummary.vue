<template>
  <aside class="v2-order-entry-summary" aria-label="订单实时核算">
    <V2SectionHeading
      class="v2-order-entry-section-header"
      title="实时核算"
      help="随订单资料和所选 ID 实时更新余额、成本与预计利润。"
    />

    <section class="v2-order-entry-disposition-control">
      <header>
        <span>ID 处理方式</span>
        <small>{{
          accountDisposition === 'sold' ? '本单售出并全局锁定' : '本单保留继续复用'
        }}</small>
      </header>
      <el-radio-group v-model="accountDisposition" class="v2-order-entry-disposition-mode">
        <el-radio value="retained">保留 ID</el-radio>
        <el-radio value="sold">卖出 ID</el-radio>
      </el-radio-group>
    </section>

    <dl class="v2-order-entry-live-summary" aria-live="polite">
      <div>
        <dt>匹配 Apple ID</dt>
        <dd>{{ selectedCandidate?.appleIdMasked || '等待匹配' }}</dd>
      </div>
      <div>
        <dt>国家 / 地区</dt>
        <dd>{{ selectedCountryName || '-' }}</dd>
      </div>
      <div>
        <dt>账号余额（可用）</dt>
        <dd>{{ formatDecimal(selectedCandidate?.currentBalance ?? '0') }}</dd>
      </div>
      <div>
        <dt>余额成本</dt>
        <dd>¥{{ formatDecimal(estimatedBalanceCostPreview) }}</dd>
      </div>
      <div>
        <dt>总成本</dt>
        <dd>¥{{ formatDecimal(totalCostPreview) }}</dd>
      </div>
      <div class="is-profit">
        <dt>预计利润</dt>
        <dd>¥{{ formatDecimal(estimatedProfitPreview) }}</dd>
      </div>
    </dl>
  </aside>
</template>

<script setup lang="ts">
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { V2OrderCandidate } from '../contracts';

defineProps<{
  selectedCandidate: V2OrderCandidate | null;
  selectedCountryName: string;
  estimatedBalanceCostPreview: string;
  totalCostPreview: string;
  estimatedProfitPreview: string;
  formatDecimal: (value: string) => string;
}>();

const accountDisposition = defineModel<'retained' | 'sold'>('accountDisposition', {
  required: true
});
</script>
