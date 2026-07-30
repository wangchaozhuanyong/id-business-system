<template>
  <main class="v2-shell v2-table-layout-fixture">
    <aside aria-hidden="true" />
    <section class="v2-content">
      <div class="v2-content__inner">
        <section data-alignment-fixture>
          <el-table :data="alignmentRows" show-overflow-tooltip>
            <V2TableColumn kind="index" width-preset="index" prop="rowNumber" label="序号" />
            <V2TableColumn kind="text" width-preset="wide" prop="customer" label="客户" />
            <V2TableColumn
              kind="identifier"
              width-preset="identifier"
              prop="orderNo"
              label="订单"
            />
            <V2TableColumn kind="numeric" width-preset="standard" label="实收金额">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </V2TableColumn>
            <V2TableColumn kind="date" width-preset="dateTime" prop="createdAt" label="创建时间" />
            <V2TableColumn kind="status" width-preset="compact" label="状态">
              <template #default="{ row }">
                <el-tag :type="row.status === '正常' ? 'success' : 'warning'" effect="plain">
                  {{ row.status }}
                </el-tag>
              </template>
            </V2TableColumn>
          </el-table>
        </section>

        <section data-layout-fixture="icon">
          <el-table :data="rows" show-overflow-tooltip>
            <V2TableColumn kind="text" prop="name" label="测试数据" min-width="420" />
            <V2TableActionColumn layout="icon">
              <AppButton icon-only size="small" variant="ghost" title="查看详情">
                <el-icon><View /></el-icon>
              </AppButton>
            </V2TableActionColumn>
          </el-table>
        </section>

        <section data-layout-fixture="single">
          <el-table :data="rows" show-overflow-tooltip>
            <V2TableColumn kind="text" prop="name" label="测试数据" min-width="420" />
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
            <V2TableColumn kind="text" prop="name" label="测试数据" min-width="420" />
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
            <V2TableColumn kind="text" prop="name" label="测试数据" min-width="420" />
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
            <V2TableColumn kind="text" prop="name" label="测试数据" min-width="420" />
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
import V2TableColumn from '@/v2/components/V2TableColumn.vue';

const rows = [{ name: '用于验证操作列不会裁切的真实组件数据' }];
const alignmentRows = [
  {
    rowNumber: 1,
    customer: '高密度业务客户',
    orderNo: 'ORD-20260729-001',
    amount: '12888.5000',
    createdAt: '2026-07-29 09:08',
    status: '正常'
  },
  {
    rowNumber: 2,
    customer: '—',
    orderNo: 'ORD-20260729-002',
    amount: '-42.2500',
    createdAt: '—',
    status: '已冻结'
  }
];
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

section[data-layout-fixture],
section[data-alignment-fixture] {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}
</style>
