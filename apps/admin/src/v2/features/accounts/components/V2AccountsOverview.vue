<template>
  <section class="v2-accounts-overview" aria-label="ID 资源概览">
    <div class="v2-accounts-overview__intro">
      <span class="v2-accounts-overview__eyebrow">ID RESOURCE WORKSPACE</span>
      <h2>ID 资源总览</h2>
      <p>当前分类为 {{ page.lifecycleLabel }}，敏感资料默认脱敏并保留访问审计。</p>
    </div>

    <div class="v2-accounts-overview__metrics" aria-label="当前页 ID 指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配 ID</small>
      </article>
      <article>
        <span>当前页</span>
        <strong>{{ page.items.length }}</strong>
        <small>本页已加载</small>
      </article>
      <article>
        <span>可直接使用</span>
        <strong>{{ usableCount }}</strong>
        <small>当前页正常可用</small>
      </article>
      <article>
        <span>已保存敏感项</span>
        <strong>{{ sensitiveCount }}</strong>
        <small>当前页需受控查看</small>
      </article>
    </div>

    <div class="v2-accounts-overview__actions">
      <AppButton variant="ghost" :disabled="page.loading" @click="page.loadAccounts">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <el-dropdown trigger="click" @command="page.handleToolbarCommand">
        <AppButton variant="ghost" :loading="page.exporting">
          <el-icon><MoreFilled /></el-icon>
          数据工具
        </AppButton>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="template">下载导入模板</el-dropdown-item>
            <el-dropdown-item v-if="page.canImport" command="import">导入 ID</el-dropdown-item>
            <el-dropdown-item command="export">导出当前结果</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <AppButton v-if="page.canCreate" variant="primary" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新增 ID
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { MoreFilled, Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{
  page: AccountsPage;
}>();

const usableCount = computed(
  () =>
    props.page.items.filter(
      (item) =>
        item.saleState === 'available' &&
        item.lossStatus === 'active' &&
        item.recordStatus === 'active' &&
        item.status.code === 'normal'
    ).length
);
const sensitiveCount = computed(
  () =>
    props.page.items.filter((item) => item.hasPassword || item.hasPhone || item.hasSecurityInfo)
      .length
);
</script>
