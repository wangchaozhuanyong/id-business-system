<template>
  <section class="v2-options-overview" aria-label="设置管理概览">
    <div class="v2-options-overview__intro">
      <span class="v2-options-overview__eyebrow">业务基础资料</span>
      <h2>业务选项总览</h2>
      <p>集中维护各业务模块共用的分类、国家、供应商和结算基础资料。</p>
    </div>

    <div class="v2-options-overview__metrics" aria-label="当前选项指标">
      <article>
        <span>配置分类</span>
        <strong>{{ page.typeDefinitions.length }}</strong>
        <small>当前可维护类型</small>
      </article>
      <article>
        <span>当前分类</span>
        <strong class="v2-options-overview__metric-text">
          {{ page.selectedTypeDefinition?.label ?? '选项' }}
        </strong>
        <small>左侧目录可切换</small>
      </article>
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配记录</small>
      </article>
      <article>
        <span>当前页启用</span>
        <strong>{{ activeCount }}</strong>
        <small>本页可选记录</small>
      </article>
    </div>

    <div class="v2-options-overview__actions">
      <AppButton variant="ghost" :disabled="page.loading" @click="page.handleRefresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
      <AppButton variant="primary" :disabled="page.loading" @click="page.openCreate">
        <el-icon><Plus /></el-icon>
        新增{{ page.selectedTypeDefinition?.label ?? '选项' }}
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useOptionsPage } from '../useOptionsPage';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

const props = defineProps<{
  page: OptionsPage;
}>();

const activeCount = computed(
  () => props.page.items.filter((item) => item.status === 'active').length
);
</script>
