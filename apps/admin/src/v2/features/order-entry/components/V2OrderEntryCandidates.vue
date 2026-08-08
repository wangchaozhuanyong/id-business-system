<template>
  <section
    class="v2-order-entry-candidates"
    :aria-label="idSelectionMode === 'manual' ? '手动选择 ID' : '自动匹配 ID'"
  >
    <V2SectionHeading
      class="v2-order-entry-section-header"
      title="ID 选择"
      :help="
        idSelectionMode === 'manual'
          ? '从搜索结果中选择符合国家、状态、余额和锁定规则的 ID。'
          : '系统按订单条件匹配可用 ID；选择结果会同步到订单资料和实时核算。'
      "
    />

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
            v-for="candidate in paginatedCandidates"
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

        <div v-if="candidateItems.length > pageSize" class="v2-order-entry-candidate-pagination">
          <span>共 {{ candidateItems.length }} 个可用 ID</span>
          <el-pagination
            v-model:current-page="currentPage"
            background
            layout="prev, pager, next"
            :page-size="pageSize"
            :total="candidateItems.length"
            aria-label="可用 ID 分页"
          />
        </div>
      </template>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { V2OrderCandidate, V2OrderMatchingResult } from '../contracts';
import type { IdSelectionMode } from '../useOrderCandidateSelection';

const props = defineProps<{
  idSelectionMode: IdSelectionMode;
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
const currentPage = ref(1);
const pageSize = 12;
const paginatedCandidates = computed(() => {
  const start = (currentPage.value - 1) * pageSize;
  return props.candidateItems.slice(start, start + pageSize);
});

watch(
  () => props.candidateItems.map((candidate) => candidate.id).join('|'),
  () => {
    currentPage.value = 1;
  }
);

watch(accountId, (value) => {
  const selectedIndex = props.candidateItems.findIndex((candidate) => candidate.id === value);
  if (selectedIndex < 0) return;
  currentPage.value = Math.floor(selectedIndex / pageSize) + 1;
});
</script>
