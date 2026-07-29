<template>
  <main class="v2-shell v2-table-layout-fixture">
    <aside aria-hidden="true" />
    <section class="v2-content">
      <div class="v2-content__inner">
        <section data-layout-fixture="icon">
          <el-table :data="rows" show-overflow-tooltip>
            <el-table-column prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="icon">
              <AppButton icon-only size="small" variant="ghost" title="查看详情">
                <el-icon><View /></el-icon>
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>

        <section data-layout-fixture="single">
          <el-table :data="rows" show-overflow-tooltip>
            <el-table-column prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="single">
              <AppButton size="small" variant="primary">
                <el-icon><CirclePlus /></el-icon>
                录入续费
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>

        <section data-layout-fixture="double">
          <el-table :data="rows" show-overflow-tooltip>
            <el-table-column prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="double">
              <AppButton size="small" variant="ghost">
                <el-icon><Edit /></el-icon>
                编辑
              </AppButton>
              <AppButton size="small" variant="danger">
                <el-icon><Delete /></el-icon>
                删除
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>

        <section data-layout-fixture="triple">
          <el-table :data="rows" show-overflow-tooltip>
            <el-table-column prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="triple">
              <AppButton size="small" variant="ghost">
                <el-icon><Edit /></el-icon>
                编辑
              </AppButton>
              <AppButton size="small" variant="soft">
                <el-icon><VideoPause /></el-icon>
                停用
              </AppButton>
              <AppButton size="small" variant="danger">
                <el-icon><Delete /></el-icon>
                删除
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>

        <section data-layout-fixture="wide">
          <el-table :data="rows" show-overflow-tooltip>
            <el-table-column prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="wide">
              <AppButton size="small" variant="primary">
                <el-icon><CircleCheck /></el-icon>
                确认开通
              </AppButton>
              <AppButton size="small" variant="ghost">
                <el-icon><View /></el-icon>
                详情
              </AppButton>
              <AppButton icon-only size="small" variant="ghost" title="修改订单">
                <el-icon><Edit /></el-icon>
              </AppButton>
              <AppButton icon-only size="small" variant="ghost" title="更多订单操作">
                <el-icon><MoreFilled /></el-icon>
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import {
  CircleCheck,
  CirclePlus,
  Delete,
  Edit,
  MoreFilled,
  VideoPause,
  View
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';

const rows = [{ name: '用于验证操作列不会裁切的真实组件数据' }];
</script>

<style scoped>
.v2-table-layout-fixture {
  min-height: 100vh;
}

.v2-table-layout-fixture > aside {
  min-width: 0;
  border-right: 1px solid var(--v2-border);
  background: var(--v2-sidebar);
}

.v2-content__inner {
  display: grid;
  gap: 14px;
}

section[data-layout-fixture] {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}
</style>
