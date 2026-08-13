<template>
  <aside class="v2-order-entry-summary" aria-label="订单实时核算">
    <V2SectionHeading
      class="v2-order-entry-section-header"
      title="实时核算"
      help="随订单资料和所选 ID 实时更新余额、成本与预计利润。"
    />

    <section class="v2-order-entry-id-config" aria-labelledby="id-config-title">
      <header>
        <div>
          <strong id="id-config-title">ID 选择方式</strong>
          <small>
            {{
              accountSource === 'inventory'
                ? '决定系统如何提供库存候选 ID。'
                : '客户已购 ID 按原客户归属筛选。'
            }}
          </small>
        </div>
        <span>{{ accountSource === 'inventory' ? '库存 ID' : '客户已购 ID' }}</span>
      </header>

      <el-radio-group
        v-if="accountSource === 'inventory'"
        v-model="idSelectionMode"
        class="v2-order-entry-selection-mode v2-order-entry-segmented-options"
        aria-label="ID 选择方式"
        @change="$emit('selection-mode-change', $event)"
      >
        <el-radio-button value="auto">自动匹配</el-radio-button>
        <el-radio-button value="manual">手动选择</el-radio-button>
      </el-radio-group>
      <div v-else class="v2-order-entry-id-config__fixed-mode">
        <strong>手动选择</strong>
        <span>仅显示当前客户名下可继续使用的 ID</span>
      </div>
    </section>

    <section class="v2-order-entry-selected-id" aria-live="polite">
      <header>
        <span>当前选中 ID</span>
        <strong :class="{ 'is-ready': Boolean(selectedCandidate) }">
          {{ selectedCandidate?.status.name || '待匹配' }}
        </strong>
      </header>
      <p>{{ selectedCandidate?.appleIdMasked || '尚未选择可用 ID' }}</p>
      <footer>
        <span>{{ selectedCountryName || '等待国家' }}</span>
        <span> 匹配余额 {{ formatDecimal(selectedCandidate?.currentBalance ?? '0') }} </span>
      </footer>
    </section>

    <dl class="v2-order-entry-live-summary" aria-live="polite">
      <div>
        <dt>可用余额</dt>
        <dd>{{ formatDecimal(selectedCandidate?.currentBalance ?? '0') }}</dd>
      </div>
      <div>
        <dt>余额成本</dt>
        <dd>¥{{ formatDecimal(estimatedBalanceCostPreview) }}</dd>
      </div>
      <div>
        <dt>ID 购买成本</dt>
        <dd>¥{{ formatDecimal(accountPurchaseCostPreview) }}</dd>
      </div>
      <div>
        <dt>平台手续费</dt>
        <dd>¥{{ formatDecimal(platformFeePreview) }}</dd>
      </div>
      <div>
        <dt>总成本</dt>
        <dd>¥{{ formatDecimal(totalCostPreview) }}</dd>
      </div>
      <div class="is-profit">
        <dt>预计利润</dt>
        <dd>
          ¥{{ formatDecimal(estimatedProfitPreview) }}
          <small v-if="estimatedProfitRatePreview">
            {{ formatDecimal(estimatedProfitRatePreview) }}%
          </small>
        </dd>
      </div>
    </dl>

    <section class="v2-order-entry-summary-note">
      <strong>核算说明</strong>
      <span>金额随售卖价格、ID 处理方式与服务端成本规则实时更新。</span>
      <span>提交时服务端会再次校验余额与成本，避免多人操作造成旧数据扣减。</span>
    </section>
  </aside>
</template>

<script setup lang="ts">
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { V2OrderAccountSource, V2OrderCandidate } from '../contracts';

defineEmits<{
  'selection-mode-change': [value: unknown];
}>();

const idSelectionMode = defineModel<'auto' | 'manual'>('idSelectionMode', { required: true });

defineProps<{
  accountSource: V2OrderAccountSource;
  selectedCandidate: V2OrderCandidate | null;
  selectedCountryName: string;
  accountPurchaseCostPreview: string;
  platformFeePreview: string;
  estimatedBalanceCostPreview: string;
  totalCostPreview: string;
  estimatedProfitPreview: string;
  estimatedProfitRatePreview: string | null;
  formatDecimal: (value: string) => string;
}>();
</script>
