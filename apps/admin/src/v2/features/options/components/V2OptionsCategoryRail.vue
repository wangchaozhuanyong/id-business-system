<template>
  <aside class="v2-options-category-panel" aria-label="选项分类目录">
    <V2SectionHeading
      class="v2-options-category-panel__heading"
      title="配置分类"
      help="切换分类只改变当前维护的数据类型，不改变增删改权限和接口。"
    >
      <template #actions>
        <span>{{ page.typeDefinitions.length }} 类</span>
      </template>
    </V2SectionHeading>

    <nav class="v2-options-category-nav" aria-label="选项类型">
      <button
        v-for="definition in page.typeDefinitions"
        :key="definition.type"
        type="button"
        :class="{ 'is-active': page.selectedType === definition.type }"
        :aria-current="page.selectedType === definition.type ? 'page' : undefined"
        :aria-pressed="page.selectedType === definition.type"
        @click="page.handleTypeChange(definition.type)"
      >
        <span class="v2-options-category-nav__icon" aria-hidden="true">
          <el-icon><component :is="page.optionTypeIcons[definition.type]" /></el-icon>
        </span>
        <span>{{ definition.label }}</span>
      </button>
    </nav>

    <footer class="v2-options-category-panel__footer">
      <el-icon aria-hidden="true"><Connection /></el-icon>
      <span>保存后会刷新相关业务模块使用的下拉资料。</span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Connection } from '@element-plus/icons-vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useOptionsPage } from '../useOptionsPage';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

defineProps<{
  page: OptionsPage;
}>();
</script>
