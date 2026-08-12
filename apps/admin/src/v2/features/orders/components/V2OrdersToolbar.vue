<template>
  <section class="v2-orders-filter-panel" aria-label="订单筛选">
    <V2SectionHeading
      class="v2-orders-filter-panel__heading"
      title="订单筛选"
      help="搜索与筛选仅影响订单列表；已有内容刷新时继续保留，避免页面跳动。"
    >
      <template #actions>
        <span class="v2-orders-filter-panel__result">当前共 {{ page.total }} 条</span>
      </template>
    </V2SectionHeading>

    <div class="v2-records-toolbar v2-orders-toolbar">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="订单号、客户、平台订单号、账号"
        aria-label="搜索订单"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-model="page.query.status"
        clearable
        placeholder="全部状态"
        aria-label="筛选订单状态"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.statusOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <el-select
        v-model="page.query.accountSource"
        clearable
        placeholder="全部 ID 来源"
        aria-label="筛选 ID 来源"
        @change="page.handleFilterChange"
      >
        <el-option label="库存 ID" value="inventory" />
        <el-option label="客户已购 ID" value="customer_owned" />
      </el-select>
      <el-select
        v-model="page.query.accountDisposition"
        clearable
        placeholder="全部 ID 处理状态"
        aria-label="筛选 ID 处理状态"
        @change="page.handleFilterChange"
      >
        <el-option
          v-for="option in page.accountDispositionOptions"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </el-select>
      <V2FilterDisclosure>
        <el-select
          v-model="page.query.serviceOptionId"
          clearable
          filterable
          placeholder="全部业务"
          aria-label="筛选业务"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.serviceOptions"
            :key="option.id"
            :label="page.selectorLabel(option)"
            :value="option.id"
          />
        </el-select>
        <el-select
          v-model="page.query.settlementPlatformOptionId"
          clearable
          filterable
          placeholder="全部结算平台"
          aria-label="筛选结算平台"
          @change="page.handleFilterChange"
        >
          <el-option
            v-for="option in page.settlementOptions"
            :key="option.id"
            :label="option.name"
            :value="option.id"
          />
        </el-select>
        <el-date-picker
          v-model="page.openedRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开通开始"
          end-placeholder="开通结束"
          aria-label="筛选开通日期"
          @change="page.handleFilterChange"
        />
      </V2FilterDisclosure>
      <div class="v2-records-toolbar__actions">
        <AppButton variant="primary" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          查询订单
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadOrders">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useOrdersPage } from '../useOrdersPage';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

defineProps<{
  page: OrdersPage;
}>();
</script>
