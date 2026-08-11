<template>
  <section class="v2-audit-command-panel" aria-label="审计日志筛选">
    <V2SectionHeading class="v2-audit-command-panel__heading" title="日志筛选">
      <template #actions>
        <span>{{
          page.activeFilterCount ? `已启用 ${page.activeFilterCount} 项筛选` : '全部记录'
        }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-audit-filter-grid">
      <el-input
        v-model="page.query.keyword"
        clearable
        placeholder="对象、说明、员工"
        aria-label="搜索审计日志"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-model="page.query.module"
        clearable
        placeholder="模块"
        aria-label="筛选审计模块"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-model="page.query.operator"
        clearable
        placeholder="操作人账号或姓名"
        aria-label="筛选操作人"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-if="page.activeTab === 'operations'"
        v-model="page.query.action"
        clearable
        placeholder="动作"
        aria-label="筛选审计动作"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-input
        v-else
        v-model="page.query.fieldName"
        clearable
        placeholder="敏感字段"
        aria-label="筛选敏感字段"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <V2FilterDisclosure>
        <el-select
          v-if="page.activeTab === 'sensitive_access'"
          v-model="page.query.approved"
          clearable
          placeholder="全部审批状态"
          aria-label="筛选敏感访问审批状态"
          @change="page.handleSearch"
        >
          <el-option label="已批准" value="true" />
          <el-option label="未批准" value="false" />
        </el-select>
        <el-date-picker
          v-model="page.createdRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="筛选审计日期"
          @change="page.handleSearch"
        />
      </V2FilterDisclosure>
      <div class="v2-audit-filter-grid__actions">
        <AppButton variant="primary" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
          查询
        </AppButton>
        <AppButton :disabled="!page.activeFilterCount" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
          重置
        </AppButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

defineProps<{ page: AuditLogsPage }>();
</script>
