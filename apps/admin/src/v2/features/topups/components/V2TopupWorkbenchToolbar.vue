<template>
  <section class="v2-topup-command-panel" aria-label="ID 加额筛选工具">
    <V2SectionHeading
      class="v2-topup-command-panel__heading"
      title="ID 筛选"
      help="按国家、余额范围和状态缩小当前未售出或已售出 ID 范围。"
    >
      <template #actions>
        <span class="v2-topup-command-panel__result">当前共 {{ page.total }} 个 ID</span>
      </template>
    </V2SectionHeading>

    <div class="v2-topup-filter-grid" aria-label="ID 加额筛选">
      <el-input
        v-model="page.query.keyword"
        clearable
        maxlength="255"
        placeholder="搜索 ID 或原销售订单号"
        aria-label="搜索 ID 或原销售订单号"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />

      <el-select
        v-model="page.query.countryOptionId"
        clearable
        placeholder="全部国家"
        aria-label="筛选国家"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.countryOptions"
          :key="option.id"
          :label="option.name"
          :value="option.id"
        />
      </el-select>

      <el-select
        v-model="page.query.balancePreset"
        clearable
        placeholder="全部余额"
        aria-label="筛选余额范围"
        @change="page.handleBalancePresetChange"
      >
        <el-option label="余额等于 0" value="zero" />
        <el-option label="大于 0 且小于 20" value="positive_under_20" />
        <el-option label="自定义" value="custom" />
      </el-select>

      <div v-if="page.query.balancePreset === 'custom'" class="v2-topup-filter-grid__range">
        <el-input
          v-model="page.query.balanceMin"
          inputmode="decimal"
          maxlength="19"
          placeholder="最低余额"
          aria-label="最低余额"
        />
        <span>至</span>
        <el-input
          v-model="page.query.balanceMax"
          inputmode="decimal"
          maxlength="19"
          placeholder="最高余额"
          aria-label="最高余额"
        />
      </div>

      <label class="v2-topup-filter-grid__normal">
        <span>只显示正常 ID</span>
        <el-switch
          v-model="page.query.onlyNormal"
          aria-label="只显示正常ID"
          @change="page.handleFilterChange"
        />
      </label>

      <div class="v2-topup-filter-grid__actions">
        <AppButton variant="primary" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          应用筛选
        </AppButton>
        <AppButton variant="ghost" @click="page.resetFilters">重置</AppButton>
      </div>
    </div>

    <footer class="v2-topup-command-panel__footer">
      <p>
        <el-icon><InfoFilled /></el-icon>
        卡片价值和卡商余额将在入账抽屉内实时核对。
      </p>
      <span>{{ filterSummary }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const filterCount = computed(
  () =>
    [
      props.page.query.countryOptionId,
      props.page.query.keyword,
      props.page.query.balancePreset,
      props.page.query.onlyNormal ? '' : 'includeAbnormal'
    ].filter(Boolean).length
);
const filterSummary = computed(() => {
  if (filterCount.value) return `已调整 ${filterCount.value} 个筛选条件`;
  return props.page.query.onlyNormal ? '当前仅显示正常 ID' : '当前显示全部状态';
});
</script>
