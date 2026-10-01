<template>
  <main class="v2-page-layout" style="padding: 16px">
    <V2PageOverview
      title="公共页面布局"
      help="长说明保留在帮助中，标题、指标和操作按可用空间换行。"
    >
      <template #metrics>
        <V2OverviewMetric label="筛选结果" :value="21" note="全部匹配资料" />
        <V2OverviewMetric label="当前页" :value="20" note="本页已加载" />
        <V2OverviewMetric
          label="资料状态"
          value="等待人工核对与资料补充"
          note="长值可查看完整提示"
        />
        <V2OverviewMetric label="敏感资料" value="无权限" note="权限外资料保持明确" />
      </template>
      <template #actions><AppButton variant="primary">新增资料</AppButton></template>
    </V2PageOverview>
    <V2ListToolbar title="资料筛选" help="该页面只使用公共组件，没有独立布局样式。">
      <el-input v-model="keyword" placeholder="搜索资料" aria-label="搜索资料" />
      <el-select v-model="status" placeholder="全部状态" aria-label="资料状态">
        <el-option label="已启用" value="active" />
      </el-select>
      <V2FilterDisclosure>
        <el-input v-model="remark" placeholder="备注" aria-label="备注" />
        <el-select v-model="source" placeholder="全部来源" aria-label="资料来源">
          <el-option label="手工录入" value="manual" />
        </el-select>
      </V2FilterDisclosure>
      <template #actions><AppButton variant="primary">查询</AppButton></template>
      <template #meta><span>当前共 21 条</span></template>
    </V2ListToolbar>
    <V2AsyncRegion phase="ready" skeleton="table" loading-title="正在加载资料">
      <section class="v2-records-list">
        <header><V2SectionHeading title="资料列表" /></header>
        <el-form
          label-position="left"
          require-asterisk-position="right"
          label-width="100px"
          style="padding: 16px"
        >
          <el-form-item label="资料名称" required><el-input v-model="name" /></el-form-item>
        </el-form>
      </section>
      <section class="v2-records-list">
        <header><V2SectionHeading title="关联记录" /></header>
      </section>
    </V2AsyncRegion>
  </main>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import V2ListToolbar from '@/v2/components/V2ListToolbar.vue';
import V2FilterDisclosure from '@/v2/components/V2FilterDisclosure.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
const keyword = ref('');
const status = ref('');
const remark = ref('');
const source = ref('');
const name = ref('');
</script>
