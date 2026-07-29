<template>
  <aside
    class="v2-order-entry-candidates"
    :aria-label="idSelectionMode === 'manual' ? '手动选择 ID' : '自动匹配 ID'"
  >
    <V2SectionHeading
      class="v2-order-entry-section-header"
      title="实时核算"
      :help="
        idSelectionMode === 'manual'
          ? '搜索并选择符合国家、状态、余额和锁定规则的 ID。'
          : '根据当前订单内容自动匹配可用 ID，并预览余额、成本、手续费与利润。'
      "
    />

    <dl class="v2-order-entry-live-summary">
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
      <div class="is-divider">
        <dt>预计消耗成本</dt>
        <dd>¥{{ formatDecimal(selectedCandidate?.estimatedBalanceCostAmount ?? '0') }}</dd>
      </div>
      <div>
        <dt>平台手续费</dt>
        <dd>¥{{ formatDecimal(platformFeePreview) }}</dd>
      </div>
      <div class="is-profit">
        <dt>预计利润</dt>
        <dd>¥{{ formatDecimal(estimatedProfitPreview) }}</dd>
      </div>
    </dl>

    <V2AsyncRegion
      variant="section"
      skeleton="cards"
      :loading="matchingLoading"
      :resolved="!canMatch || Boolean(matchingResult)"
      :empty="!canMatch || (Boolean(matchingResult) && !candidateItems.length)"
      :error="matchingError"
      :loading-title="idSelectionMode === 'manual' ? '正在搜索可用 ID' : '正在匹配可用 ID'"
      refreshing-title="正在更新匹配结果"
      :empty-title="canMatch ? '没有可用 ID' : '等待业务和消耗余额'"
      :empty-message="canMatch ? matchingEmptyMessage : '请选择业务并填写有效的消耗余额。'"
      :error-title="idSelectionMode === 'manual' ? '手动搜索失败' : '自动匹配失败'"
      @retry="$emit('retry')"
    >
      <template v-if="matchingResult">
        <dl class="v2-order-entry-counts">
          <div>
            <dt>国家启用</dt>
            <dd>{{ matchingResult.counts.activeInCountry }}</dd>
          </div>
          <div>
            <dt>状态正常</dt>
            <dd>{{ matchingResult.counts.normalStatus }}</dd>
          </div>
          <div>
            <dt>余额足够</dt>
            <dd>{{ matchingResult.counts.sufficientBalance }}</dd>
          </div>
          <div>
            <dt>当前可用</dt>
            <dd>{{ matchingResult.counts.available }}</dd>
          </div>
        </dl>

        <el-radio-group v-model="accountId" class="v2-order-entry-candidate-list">
          <el-radio
            v-for="candidate in candidateItems"
            :key="candidate.id"
            :value="candidate.id"
            class="v2-order-entry-candidate"
          >
            <span class="v2-order-entry-candidate-main">
              <strong>{{ candidate.appleIdMasked }}</strong>
              <small>{{ candidate.country.name }} / {{ candidate.status.name }}</small>
              <small>平均成本 ¥{{ formatDecimal(candidate.averageCost) }}</small>
            </span>
            <span class="v2-order-entry-candidate-balance">
              <strong>{{ formatDecimal(candidate.currentBalance) }}</strong>
              <small>匹配后 {{ formatDecimal(candidate.balanceAfterMatch) }}</small>
            </span>
          </el-radio>
        </el-radio-group>
      </template>
    </V2AsyncRegion>
  </aside>
</template>

<script setup lang="ts">
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { V2OrderCandidate, V2OrderMatchingResult } from '../contracts';
import type { IdSelectionMode } from '../useOrderCandidateSelection';

defineProps<{
  idSelectionMode: IdSelectionMode;
  selectedCandidate: V2OrderCandidate | null;
  selectedCountryName: string;
  platformFeePreview: string;
  estimatedProfitPreview: string;
  canMatch: boolean;
  matchingLoading: boolean;
  matchingResult: V2OrderMatchingResult | null;
  candidateItems: V2OrderCandidate[];
  matchingError: string;
  matchingEmptyMessage: string;
  formatDecimal: (value: string) => string;
}>();

defineEmits<{
  retry: [];
}>();

const accountId = defineModel<string>('accountId', { required: true });
</script>
