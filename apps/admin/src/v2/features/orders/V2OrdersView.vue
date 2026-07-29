<template>
  <section class="v2-records-page">
    <section class="v2-records-toolbar v2-orders-toolbar" aria-label="订单筛选">
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
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.loadOrders">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2OrdersList :page="page" />
    <V2OrderDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2OrderDialogs from './components/V2OrderDialogs.vue';
import V2OrdersList from './components/V2OrdersList.vue';
import { useOrdersPage } from './useOrdersPage';
import '@/v2/styles/records.css';
import '@/v2/styles/orders.css';

const page = reactive(useOrdersPage());
</script>
