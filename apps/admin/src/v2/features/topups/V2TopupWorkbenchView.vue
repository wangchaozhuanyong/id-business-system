<template>
  <section class="v2-records-page v2-topup-workbench">
    <section class="v2-topup-toolbar" aria-label="加卡工作台筛选">
      <label class="v2-topup-filter">
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
      </label>

      <label class="v2-topup-filter">
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
      </label>

      <div v-if="page.query.balancePreset === 'custom'" class="v2-topup-filter v2-topup-range">
        <span>自定义余额</span>
        <div>
          <el-input
            v-model="page.query.balanceMin"
            inputmode="decimal"
            maxlength="19"
            placeholder="最低"
            aria-label="最低余额"
          />
          <span>至</span>
          <el-input
            v-model="page.query.balanceMax"
            inputmode="decimal"
            maxlength="19"
            placeholder="最高"
            aria-label="最高余额"
          />
        </div>
      </div>

      <label class="v2-topup-normal-filter">
        <span>只显示正常 ID</span>
        <el-switch
          v-model="page.query.onlyNormal"
          aria-label="只显示正常ID"
          @change="page.handleFilterChange"
        />
      </label>

      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="应用筛选" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新数据" :disabled="page.loading" @click="page.loadWorkbench">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <V2TopupWorkbenchList :page="page" />
    <V2TopupWorkbenchDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2TopupWorkbenchDialogs from './components/V2TopupWorkbenchDialogs.vue';
import V2TopupWorkbenchList from './components/V2TopupWorkbenchList.vue';
import { useTopupWorkbenchPage } from './useTopupWorkbenchPage';
import '@/v2/styles/records.css';
import '@/v2/styles/topup-workbench.css';

const page = reactive(useTopupWorkbenchPage());
</script>
