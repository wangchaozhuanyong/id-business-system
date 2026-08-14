<template>
  <section class="v2-renewal-command-panel" aria-label="续费记录筛选工具">
    <V2SectionHeading
      class="v2-renewal-command-panel__heading"
      title="续费筛选"
      help="使用订单、客户、ID 账号、网站账号、到期状态和日期范围缩小续费待办。"
    >
      <template #actions>
        <span class="v2-renewal-command-panel__result">当前共 {{ page.total }} 条</span>
      </template>
    </V2SectionHeading>

    <div class="v2-renewal-filter-grid" aria-label="续费记录筛选">
      <el-input
        v-model="page.query.keyword"
        class="v2-renewal-filter-grid__search"
        clearable
        placeholder="订单、客户、ID账号、网站账号"
        aria-label="搜索续费记录"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <div class="v2-renewal-scope-control" role="group" aria-label="续费到期范围">
        <button
          v-for="item in page.renewalStatusStripItems"
          :key="item.key"
          type="button"
          class="v2-renewal-scope-control__button"
          :class="[`is-${item.tone}`, { 'is-active': page.activeWarningScope === item.key }]"
          :aria-pressed="page.activeWarningScope === item.key"
          @click="page.selectWarningScope(item.key)"
        >
          <span>{{ item.label }}</span>
          <strong>{{ item.count }}</strong>
        </button>
      </div>
      <el-date-picker
        v-model="page.dueRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="到期开始"
        end-placeholder="到期结束"
        aria-label="自行设定到期日期范围"
        @change="page.handleTimeFilterChange"
      />
      <V2FilterDisclosure
        :label="advancedFilterCount ? `更多筛选 · ${advancedFilterCount}` : '更多筛选'"
      >
        <el-select
          v-model="page.query.dueStatus"
          clearable
          placeholder="全部到期状态"
          aria-label="筛选到期状态"
          @change="page.handleTimeFilterChange"
        >
          <el-option
            v-for="option in page.dueStatusOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <el-select
          v-model="page.query.customerId"
          clearable
          filterable
          placeholder="全部客户"
          aria-label="筛选客户"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.filterOptions.customers"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.serviceOptionId"
          clearable
          filterable
          placeholder="全部业务"
          aria-label="筛选业务"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.filterOptions.services"
            :key="option.id"
            :label="page.serviceLabel(option)"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.accountId"
          clearable
          filterable
          placeholder="全部 ID"
          aria-label="筛选苹果 ID"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.filterOptions.accounts"
            :key="option.id"
            :label="option.appleIdMasked"
            :value="option.id"
          />
        </el-select>
      </V2FilterDisclosure>
      <AppButton variant="primary" @click="page.handleSearch">
        <el-icon><Search /></el-icon>
        查询续费
      </AppButton>
      <AppButton v-if="activeFilterCount" variant="ghost" @click="resetFilters"> 重置 </AppButton>
    </div>

    <footer class="v2-renewal-command-panel__footer">
      <p>
        <el-icon><Timer /></el-icon>
        可查看任意日期，仅允许对 7 天内到期或已到期记录执行续费。
      </p>
      <span v-if="activeFilterCount">已启用 {{ activeFilterCount }} 个筛选条件</span>
      <span v-else>默认显示未来 {{ page.warningDays }} 天预警</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Search, Timer } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useRenewalsPage } from '../useRenewalsPage';

type RenewalsPage = UnwrapNestedRefs<ReturnType<typeof useRenewalsPage>>;

const props = defineProps<{
  page: RenewalsPage;
}>();

const advancedFilterCount = computed(
  () =>
    [
      props.page.query.dueStatus,
      props.page.query.customerId,
      props.page.query.serviceOptionId,
      props.page.query.accountId
    ].filter(Boolean).length
);
const activeFilterCount = computed(
  () =>
    [
      props.page.query.keyword.trim(),
      props.page.query.dueStatus,
      props.page.dueRange.length ? 'dueRange' : '',
      props.page.query.customerId,
      props.page.query.serviceOptionId,
      props.page.query.accountId
    ].filter(Boolean).length
);

function resetFilters() {
  Object.assign(props.page.query, {
    page: 1,
    keyword: '',
    customerId: '',
    serviceOptionId: '',
    accountId: '',
    dueStatus: ''
  });
  props.page.dueRange.splice(0);
  props.page.selectWarningScope('warning');
}
</script>
