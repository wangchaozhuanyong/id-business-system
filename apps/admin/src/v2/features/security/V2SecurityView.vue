<template>
  <section class="v2-records-page v2-security-page">
    <V2StatusStrip
      :items="page.statusItems"
      aria-label="安全状态概览"
      @select="page.selectMetric"
    />

    <el-tabs
      v-model="page.activeTab"
      class="v2-security-page__tabs"
      @tab-change="page.handleTabChange"
    >
      <el-tab-pane label="登录记录" name="login_logs" />
      <el-tab-pane label="在线会话" name="sessions" />
      <el-tab-pane label="MFA 与白名单" name="policy" />
    </el-tabs>

    <section class="v2-records-toolbar v2-security-page__toolbar" aria-label="安全中心筛选">
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
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="搜索" @click="page.handleSearch">
          <el-icon><Search /></el-icon>
        </AppButton>
        <AppButton icon-only title="重置筛选" @click="page.resetFilters">
          <el-icon><RefreshLeft /></el-icon>
        </AppButton>
        <AppButton icon-only title="刷新" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </section>

    <p class="v2-records-security-note">
      <el-icon><Lock /></el-icon>
      强制下线、策略状态和白名单读取均受管理员角色保护；强制下线会写入操作审计。
    </p>

    <V2AsyncRegion
      skeleton="table"
      :loading="page.loading"
      :resolved="page.resolved"
      :error="page.listError"
      loading-title="正在加载安全中心"
      refreshing-title="正在更新安全状态"
      error-title="安全中心加载失败"
      @retry="page.refresh"
    >
      <V2SecurityPolicyPanel v-if="page.activeTab === 'policy'" :page="page" />
      <V2SecurityRecordsPanel v-else :page="page" />
    </V2AsyncRegion>

    <V2SecurityPolicyDialogs :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { Lock, Refresh, RefreshLeft, Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2StatusStrip from '@/v2/components/V2StatusStrip.vue';
import V2SecurityPolicyPanel from './components/V2SecurityPolicyPanel.vue';
import V2SecurityPolicyDialogs from './components/V2SecurityPolicyDialogs.vue';
import V2SecurityRecordsPanel from './components/V2SecurityRecordsPanel.vue';
import { useSecurityPage } from './useSecurityPage';
import '@/v2/styles/records.css';

const page = reactive(useSecurityPage());
</script>

<style scoped>
.v2-security-page__tabs {
  margin-bottom: 4px;
}

.v2-security-page__toolbar {
  grid-template-columns: minmax(220px, 1fr) repeat(2, minmax(140px, 180px)) auto;
}

@media (max-width: 900px) {
  .v2-security-page__toolbar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
