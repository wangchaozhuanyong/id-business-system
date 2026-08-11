<template>
  <section class="v2-security-command-panel" aria-label="安全中心筛选">
    <V2SectionHeading class="v2-security-command-panel__heading" title="安全记录筛选">
      <template #actions>
        <span>{{
          page.activeFilterCount ? `已启用 ${page.activeFilterCount} 项筛选` : '全部记录'
        }}</span>
      </template>
    </V2SectionHeading>

    <div class="v2-security-filter-grid">
      <el-input
        v-model="page.query.keyword"
        clearable
        :placeholder="page.activeTab === 'policy' ? 'IP、CIDR 或说明' : '账号、IP 或客户端'"
        aria-label="搜索安全记录"
        @keyup.enter="page.handleSearch"
        @clear="page.handleSearch"
      />
      <el-select
        v-if="page.activeTab === 'login_logs'"
        v-model="page.query.status"
        clearable
        placeholder="全部登录结果"
        aria-label="筛选登录结果"
        @change="page.handleSearch"
      >
        <el-option label="成功" value="success" />
        <el-option label="失败" value="failed" />
        <el-option label="已拦截" value="blocked" />
      </el-select>
      <el-select
        v-if="page.activeTab === 'login_logs'"
        v-model="page.query.abnormal"
        clearable
        placeholder="全部风险"
        aria-label="筛选登录风险"
        @change="page.handleSearch"
      >
        <el-option label="异常" value="true" />
        <el-option label="正常" value="false" />
      </el-select>
      <el-select
        v-if="page.activeTab === 'sessions'"
        v-model="page.query.revoked"
        clearable
        placeholder="全部会话状态"
        aria-label="筛选会话状态"
        @change="page.handleSearch"
      >
        <el-option label="在线" value="false" />
        <el-option label="已下线" value="true" />
      </el-select>
      <template v-if="page.activeTab === 'policy'">
        <el-select
          v-model="page.query.scope"
          clearable
          placeholder="全部应用范围"
          aria-label="筛选白名单范围"
          @change="page.handleSearch"
        >
          <el-option label="管理端" value="admin" />
          <el-option label="API" value="api" />
        </el-select>
        <el-select
          v-model="page.query.enabled"
          clearable
          placeholder="全部启用状态"
          aria-label="筛选白名单状态"
          @change="page.handleSearch"
        >
          <el-option label="启用" value="true" />
          <el-option label="停用" value="false" />
        </el-select>
      </template>
      <div class="v2-security-filter-grid__actions">
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
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

defineProps<{ page: SecurityPage }>();
</script>
