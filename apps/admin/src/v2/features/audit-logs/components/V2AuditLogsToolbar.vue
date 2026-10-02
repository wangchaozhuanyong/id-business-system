<template>
  <V2ListToolbar class="v2-audit-command-panel" aria-label="审计日志筛选" title="日志筛选">
    <el-input
      v-model="page.query.keyword"
      clearable
      placeholder="资料名称、说明、员工"
      aria-label="搜索审计日志"
      @keyup.enter="page.handleSearch"
      @clear="page.handleSearch"
    />
    <el-select
      v-model="page.query.module"
      clearable
      placeholder="全部业务分类"
      aria-label="筛选业务分类"
      @change="page.handleSearch"
      ><el-option
        v-for="option in page.auditModuleOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
    /></el-select>
    <el-input
      v-model="page.query.operator"
      clearable
      placeholder="操作人账号或姓名"
      aria-label="筛选操作人"
      @keyup.enter="page.handleSearch"
      @clear="page.handleSearch"
    />
    <el-select
      v-if="page.activeTab === 'operations'"
      v-model="page.query.action"
      clearable
      placeholder="全部操作类型"
      aria-label="筛选操作类型"
      @change="page.handleSearch"
      ><el-option
        v-for="option in page.auditActionOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
    /></el-select>
    <el-select
      v-else
      v-model="page.query.fieldName"
      clearable
      placeholder="全部查看内容"
      aria-label="筛选查看内容"
      @change="page.handleSearch"
      ><el-option
        v-for="option in page.auditSensitiveFieldOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
    /></el-select>
    <el-select
      v-if="page.activeTab === 'operations'"
      v-model="page.query.activity"
      aria-label="筛选记录范围"
      @change="page.handleSearch"
    >
      <el-option label="员工操作" value="staff" /><el-option label="系统自动记录" value="system" />
      <el-option label="全部记录" value="all" /><el-option label="删除记录" value="deletions" />
    </el-select>
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
    <template #actions
      ><AppButton variant="primary" @click="page.handleSearch">
        <el-icon><Search /></el-icon>
        查询
      </AppButton>
      <AppButton :disabled="!page.activeFilterCount" @click="page.resetFilters">
        <el-icon><RefreshLeft /></el-icon>
        重置
      </AppButton></template
    >
    <template #meta>
      <span>{{
        page.activeFilterCount ? `已启用 ${page.activeFilterCount} 项筛选` : '未设置其他筛选'
      }}</span>
    </template>
  </V2ListToolbar>
</template>

<script setup lang="ts">
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import type { UnwrapNestedRefs } from 'vue';
import { RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import type { useAuditLogsPage } from '../useAuditLogsPage';

type AuditLogsPage = UnwrapNestedRefs<ReturnType<typeof useAuditLogsPage>>;

defineProps<{ page: AuditLogsPage }>();
</script>
