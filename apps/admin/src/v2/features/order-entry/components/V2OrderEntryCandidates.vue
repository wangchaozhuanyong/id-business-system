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
          : '根据当前订单内容自动匹配可用 ID，并预览余额、成本与利润。'
      "
    />

    <div class="v2-order-entry-candidate-controls">
      <section>
        <header>
          <span>ID 选择方式</span>
          <small>{{ idSelectionMode === 'manual' ? '搜索指定 ID' : '系统自动匹配' }}</small>
        </header>
        <el-radio-group
          v-model="idSelectionMode"
          class="v2-order-entry-selection-mode"
          @change="emitSelectionModeChange"
        >
          <el-radio value="auto">自动匹配</el-radio>
          <el-radio value="manual">手动选择</el-radio>
        </el-radio-group>
      </section>

      <section>
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
    </div>

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
              <small>ID 购买成本 ¥{{ formatDecimal(candidate.purchaseCost) }}</small>
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
  selectedCandidate: V2OrderCandidate | null;
  selectedCountryName: string;
  estimatedBalanceCostPreview: string;
  totalCostPreview: string;
  estimatedProfitPreview: string;
  canMatch: boolean;
  matchingLoading: boolean;
  matchingResult: V2OrderMatchingResult | null;
  candidateItems: V2OrderCandidate[];
  matchingError: string;
  matchingEmptyMessage: string;
  formatDecimal: (value: string) => string;
}>();

const emit = defineEmits<{
  retry: [];
  selectionModeChange: [value: IdSelectionMode];
}>();

const accountId = defineModel<string>('accountId', { required: true });
const idSelectionMode = defineModel<IdSelectionMode>('idSelectionMode', { required: true });
const accountDisposition = defineModel<'retained' | 'sold'>('accountDisposition', {
  required: true
});

function emitSelectionModeChange(value: unknown) {
  if (value === 'auto' || value === 'manual') {
    emit('selectionModeChange', value);
  }
}
</script>
