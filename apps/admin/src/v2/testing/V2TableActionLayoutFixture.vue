<template>
  <main class="v2-shell v2-table-layout-fixture">
    <aside aria-hidden="true" />
    <section class="v2-content">
      <div class="v2-content__inner">
        <section data-alignment-fixture>
          <V2Table :schema="fixtureSchemas.alignment" :data="alignmentRows">
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[0]" prop="rowNumber" />
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[1]" prop="customer" />
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[2]" prop="orderNo" />
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[3]">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[4]" prop="createdAt" />
            <V2TableColumn :definition="fixtureSchemas.alignment.columns[5]">
              <template #default="{ row }">
                <el-tag :type="row.status === '正常' ? 'success' : 'warning'" effect="plain">
                  {{ row.status }}
                </el-tag>
              </template>
            </V2TableColumn>
          </V2Table>
        </section>

        <section class="v2-table-layout-fixture__narrow" data-narrow-container>
          <V2Table :schema="fixtureSchemas.narrow" :data="alignmentRows">
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[0]" prop="rowNumber" />
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[1]" prop="customer" />
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[2]" prop="orderNo" />
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[3]">
              <template #default="{ row }">¥{{ row.amount }}</template>
            </V2TableColumn>
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[4]" prop="createdAt" />
            <V2TableColumn :definition="fixtureSchemas.narrow.columns[5]">
              <template #default="{ row }">
                <el-tag :type="row.status === '正常' ? 'success' : 'warning'" effect="plain">
                  {{ row.status }}
                </el-tag>
              </template>
            </V2TableColumn>
          </V2Table>
        </section>

        <section data-scroll-lifecycle>
          <div class="v2-table-layout-fixture__controls">
            <button type="button" data-update-same-table @click="lifecycleRevision += 1">
              更新同表数据
            </button>
            <button type="button" data-switch-schema @click="switchLifecycleSchema">
              切换 schema
            </button>
          </div>
          <V2Table :schema="lifecycleSchema" :data="lifecycleRows">
            <V2TableColumn
              v-for="definition in lifecycleSchema.columns"
              :key="definition.key"
              :definition="definition"
              :prop="definition.key"
            />
          </V2Table>
        </section>

        <section data-layout-fixture="icon">
          <V2Table :schema="fixtureSchemas.icon" :data="rows">
            <V2TableColumn :definition="fixtureSchemas.icon.columns[0]" prop="name" />
            <V2TableActionColumn :definition="fixtureSchemas.icon.columns[1]">
              <AppButton icon-only size="small" variant="ghost" title="查看详情">
                <el-icon><View /></el-icon>
              </AppButton>
            </V2TableActionColumn>
          </V2Table>
        </section>

        <section data-layout-fixture="single">
          <V2Table :schema="fixtureSchemas.single" :data="rows">
            <V2TableColumn :definition="fixtureSchemas.single.columns[0]" prop="name" />
            <V2TableActionColumn :definition="fixtureSchemas.single.columns[1]">
              <AppButton size="small" variant="primary">
                <el-icon><CirclePlus /></el-icon>
                录入续费
              </AppButton>
            </V2TableActionColumn>
          </V2Table>
        </section>

        <section data-layout-fixture="double">
          <V2Table :schema="fixtureSchemas.double" :data="rows">
            <V2TableColumn :definition="fixtureSchemas.double.columns[0]" prop="name" />
            <V2TableActionColumn :definition="fixtureSchemas.double.columns[1]">
              <AppButton size="small" variant="ghost">
                <el-icon><Edit /></el-icon>
                编辑
              </AppButton>
              <AppButton size="small" variant="danger">
                <el-icon><Delete /></el-icon>
                删除
              </AppButton>
            </V2TableActionColumn>
          </V2Table>
        </section>

        <section data-layout-fixture="triple">
          <V2Table :schema="fixtureSchemas.triple" :data="rows">
            <V2TableColumn :definition="fixtureSchemas.triple.columns[0]" prop="name" />
            <V2TableActionColumn :definition="fixtureSchemas.triple.columns[1]">
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
          </V2Table>
        </section>

        <section data-layout-fixture="wide">
          <V2Table :schema="fixtureSchemas.wide" :data="rows">
            <V2TableColumn :definition="fixtureSchemas.wide.columns[0]" prop="name" />
            <V2TableActionColumn :definition="fixtureSchemas.wide.columns[1]">
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
          </V2Table>
        </section>

        <section
          v-for="schema in registeredSchemas"
          :key="schema.id"
          :data-schema-fixture="schema.id"
          :data-schema-columns="schema.columns.length"
        >
          <V2Table
            :schema="schema"
            :data="registryRows"
            :show-column-settings="false"
            :apply-default-column-visibility="false"
          >
            <template v-for="definition in schema.columns" :key="definition.key">
              <V2TableActionColumn v-if="definition.kind === 'actions'" :definition="definition">
                <AppButton size="small" variant="ghost">操作</AppButton>
              </V2TableActionColumn>
              <V2TableControlColumn
                v-else-if="definition.kind === 'control'"
                :definition="definition"
              >
                <span v-if="definition.control === 'expand'">展开内容</span>
              </V2TableControlColumn>
              <V2TableColumn v-else :definition="definition">
                <span>{{ definition.label }}</span>
              </V2TableColumn>
            </template>
          </V2Table>
        </section>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableControlColumn from '@/v2/components/V2TableControlColumn.vue';
import { defineV2TableSchema, type V2TableSchema } from '@/v2/components/tableSystem';
import { v2TableSchemas } from '@/v2/features/tableSchemas';

const alignmentColumns = [
  { key: 'rowNumber', label: '序号', kind: 'index', widthPreset: 'index' },
  { key: 'customer', label: '客户', kind: 'text', widthPreset: 'wide' },
  { key: 'orderNo', label: '订单', kind: 'identifier', widthPreset: 'identifier' },
  { key: 'amount', label: '实收金额', kind: 'numeric', widthPreset: 'standard' },
  { key: 'createdAt', label: '创建时间', kind: 'date', widthPreset: 'dateTime' },
  { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' }
] as const;

const actionFixtureSchema = (layout: 'icon' | 'single' | 'double' | 'triple' | 'wide') =>
  defineV2TableSchema({
    id: `fixture.${layout}`,
    feature: 'table-layout-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: null,
    columns: [
      { key: 'name', label: '测试数据', kind: 'text', widthPreset: 'longText' },
      { key: 'actions', label: '操作', kind: 'actions', layout, pin: 'end' }
    ]
  } as const);

const fixtureSchemas = {
  alignment: defineV2TableSchema({
    id: 'fixture.alignment',
    feature: 'table-layout-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: null,
    columns: alignmentColumns
  }),
  narrow: defineV2TableSchema({
    id: 'fixture.narrow-container',
    feature: 'table-layout-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: null,
    columns: alignmentColumns
  }),
  icon: actionFixtureSchema('icon'),
  single: actionFixtureSchema('single'),
  double: actionFixtureSchema('double'),
  triple: actionFixtureSchema('triple'),
  wide: actionFixtureSchema('wide')
} as const;

const lifecycleSchemas = [
  defineV2TableSchema({
    id: 'fixture.lifecycle.primary',
    feature: 'table-layout-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: null,
    columns: alignmentColumns
  }),
  defineV2TableSchema({
    id: 'fixture.lifecycle.alternate',
    feature: 'table-layout-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: null,
    columns: alignmentColumns
  })
] as const;

const lifecycleSchemaIndex = ref(0);
const lifecycleRevision = ref(0);
const lifecycleSchema = computed(() => lifecycleSchemas[lifecycleSchemaIndex.value]);
const lifecycleRows = computed(() =>
  alignmentRows.map((row) => ({
    ...row,
    customer: `${row.customer} ${lifecycleRevision.value}`
  }))
);
const registeredSchemas = Object.values(v2TableSchemas).flatMap((schemas) =>
  Object.values(schemas)
) as readonly V2TableSchema[];

const registryRows = [
  {
    id: 'fixture-row',
    supplier: { id: 'fixture-supplier' },
    currency: 'CNY',
    month: '2026-07'
  }
];

function switchLifecycleSchema() {
  lifecycleSchemaIndex.value = lifecycleSchemaIndex.value === 0 ? 1 : 0;
}

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
section[data-alignment-fixture],
section[data-narrow-container],
section[data-scroll-lifecycle],
section[data-schema-fixture] {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-table-layout-fixture__narrow {
  width: min(480px, 100%);
  justify-self: start;
}

.v2-table-layout-fixture__controls {
  display: flex;
  gap: 8px;
  padding: 8px;
}
</style>
