<template>
  <main class="v2-shell v2-theme-components" data-theme-components-fixture>
    <header class="v2-theme-components__header">
      <p>全局主题契约</p>
      <h1>Element Plus 组件状态</h1>
    </header>

    <section class="v2-theme-components__overview" data-theme-overview>
      <div>
        <span data-theme-overview-accent>业务基础资料</span>
        <h2 data-theme-overview-title>业务选项总览</h2>
        <p data-theme-overview-copy>集中维护业务模块共用的分类、国家和结算基础资料。</p>
      </div>
      <div class="v2-theme-components__overview-metrics">
        <article>
          <span data-theme-overview-metric-label>配置分类</span>
          <strong data-theme-overview-metric-value>11</strong>
          <small>当前可维护类型</small>
        </article>
        <article>
          <span>筛选结果</span>
          <strong>2</strong>
          <small>全部匹配记录</small>
        </article>
      </div>
    </section>

    <section class="v2-theme-components__band" data-theme-band="form">
      <h2>表单控件</h2>
      <el-form
        :model="form"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
      >
        <div class="v2-theme-components__form-grid">
          <el-form-item label="文本输入">
            <el-input v-model="form.keyword" placeholder="请输入关键词" />
          </el-form-item>
          <el-form-item label="国家选择">
            <el-select v-model="form.country" placeholder="请选择国家">
              <el-option label="美国" value="US" />
              <el-option label="菲律宾" value="PH" />
            </el-select>
          </el-form-item>
          <el-form-item label="业务日期">
            <el-date-picker
              v-model="form.date"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="请选择日期"
            />
          </el-form-item>
          <el-form-item label="业务数量">
            <el-input-number v-model="form.amount" :min="0" :max="99" />
          </el-form-item>
          <el-form-item class="v2-theme-components__wide" label="业务备注">
            <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="请输入备注" />
          </el-form-item>
        </div>
      </el-form>
      <div class="v2-theme-components__choices">
        <el-checkbox v-model="form.enabled">启用记录</el-checkbox>
        <el-radio-group v-model="form.mode">
          <el-radio value="auto">自动</el-radio>
          <el-radio value="manual">手动</el-radio>
        </el-radio-group>
        <el-switch v-model="form.onlyNormal" active-text="仅正常 ID" />
      </div>
    </section>

    <section class="v2-theme-components__band" data-theme-band="data">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="数据列表" name="list">
          <V2Table
            :schema="fixtureSchemas.themeComponents"
            :show-column-settings="false"
            :data="rows"
            border
          >
            <V2TableColumn :definition="fixtureSchemas.themeComponents.columns[0]" prop="id" />
            <V2TableColumn :definition="fixtureSchemas.themeComponents.columns[1]" prop="country" />
            <V2TableColumn :definition="fixtureSchemas.themeComponents.columns[2]" prop="balance" />
            <V2TableColumn :definition="fixtureSchemas.themeComponents.columns[3]">
              <template #default="{ row }">
                <el-tag :type="row.statusType" effect="plain">
                  {{ row.statusLabel }}
                </el-tag>
              </template>
            </V2TableColumn>
          </V2Table>
          <el-pagination
            v-model:current-page="currentPage"
            class="v2-theme-components__pagination"
            background
            layout="prev, pager, next"
            :page-size="10"
            :total="60"
          />
        </el-tab-pane>
        <el-tab-pane label="空状态" name="empty">
          <el-empty description="暂无业务数据" />
        </el-tab-pane>
      </el-tabs>
    </section>

    <section class="v2-theme-components__band" data-theme-band="overlay">
      <h2>浮层与反馈</h2>
      <div class="v2-theme-components__actions">
        <el-dropdown trigger="click">
          <AppButton data-theme-dropdown-trigger variant="ghost">更多操作</AppButton>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item>查看详情</el-dropdown-item>
              <el-dropdown-item divided>导出记录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <AppButton data-theme-dialog-trigger variant="soft" @click="dialogVisible = true">
          打开弹窗
        </AppButton>
        <AppButton data-theme-drawer-trigger variant="primary" @click="drawerVisible = true">
          打开抽屉
        </AppButton>
      </div>
    </section>

    <el-dialog v-model="dialogVisible" title="业务确认" width="min(460px, 92vw)">
      <p data-theme-dialog-copy>确认后将按当前筛选条件继续处理。</p>
      <template #footer>
        <AppButton data-theme-dialog-close variant="ghost" @click="dialogVisible = false">
          取消
        </AppButton>
        <AppButton variant="primary" @click="dialogVisible = false">确认</AppButton>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" title="新增业务资料" size="min(420px, 94vw)">
      <p data-theme-drawer-copy>抽屉、表单和浮层必须继承当前主题。</p>
      <template #footer>
        <AppButton data-theme-drawer-close variant="ghost" @click="drawerVisible = false">
          关闭
        </AppButton>
      </template>
    </el-drawer>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { defineV2TableSchema } from '@/v2/components/tableSystem';

const fixtureSchemas = {
  themeComponents: defineV2TableSchema({
    id: 'fixture.theme-components',
    feature: 'theme-components-fixture',
    role: 'embedded',
    mobileMode: 'scroll',
    rowKey: { kind: 'path', value: 'id' },
    columns: [
      { key: 'id', label: 'ID 账号', kind: 'identifier', widthPreset: 'identifier' },
      { key: 'country', label: '国家', kind: 'text', widthPreset: 'compact' },
      { key: 'balance', label: '余额', kind: 'numeric', widthPreset: 'compact' },
      { key: 'status', label: '状态', kind: 'status', widthPreset: 'compact' }
    ]
  })
} as const;

const form = reactive({
  keyword: 'ID 余额',
  country: 'US',
  date: '2026-08-11',
  amount: 2,
  remark: '主题组件验收数据',
  enabled: true,
  mode: 'auto',
  onlyNormal: true
});
const activeTab = ref('list');
const currentPage = ref(2);
const dialogVisible = ref(false);
const drawerVisible = ref(false);
const rows = [
  {
    id: 'te********@icloud.com',
    country: '美国',
    balance: '144.00',
    statusType: 'success' as const,
    statusLabel: '已完成'
  },
  {
    id: 'qa********@icloud.com',
    country: '菲律宾',
    balance: '300.00',
    statusType: 'primary' as const,
    statusLabel: '处理中'
  },
  {
    id: 'wa********@icloud.com',
    country: '日本',
    balance: '88.00',
    statusType: 'warning' as const,
    statusLabel: '待处理'
  },
  {
    id: 'fa********@icloud.com',
    country: '英国',
    balance: '0.00',
    statusType: 'danger' as const,
    statusLabel: '失败'
  },
  {
    id: 'ca********@icloud.com',
    country: '加拿大',
    balance: '20.00',
    statusType: 'info' as const,
    statusLabel: '已取消'
  }
];
</script>

<style scoped>
.v2-theme-components.v2-shell {
  display: block;
  min-height: 100dvh;
  height: auto;
  overflow: visible;
  padding: 28px max(16px, calc((100vw - 1120px) / 2));
}

.v2-theme-components__header {
  margin-bottom: 18px;
}

.v2-theme-components__header p,
.v2-theme-components__header h1,
.v2-theme-components__band h2,
.v2-theme-components :deep(.el-dialog p),
.v2-theme-components :deep(.el-drawer p) {
  margin: 0;
}

.v2-theme-components__header p {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-theme-components__header h1 {
  margin-top: 4px;
  font-size: 22px;
}

.v2-theme-components__overview {
  display: grid;
  grid-template-columns: minmax(240px, 0.85fr) minmax(360px, 1.15fr);
  align-items: center;
  gap: 20px;
  margin-bottom: 18px;
  padding: 18px 20px;
  border: 1px solid var(--v2-overview-border);
  border-radius: var(--v3-radius);
  background: var(--v2-overview-bg);
  color: var(--v2-overview-text);
  box-shadow: var(--v2-overview-shadow);
}

.v2-theme-components__overview > div:first-child {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-theme-components__overview h2,
.v2-theme-components__overview p {
  margin: 0;
}

.v2-theme-components__overview > div:first-child > span {
  color: var(--v2-overview-accent);
  font-size: 10px;
  font-weight: var(--v3-font-weight-bold);
}

.v2-theme-components__overview h2 {
  color: var(--v2-overview-text);
  font-size: 17px;
}

.v2-theme-components__overview p,
.v2-theme-components__overview-metrics span,
.v2-theme-components__overview-metrics small {
  color: var(--v2-overview-text-soft);
  font-size: 11px;
}

.v2-theme-components__overview-metrics {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--v2-overview-divider);
  border-radius: var(--v3-radius-sm);
}

.v2-theme-components__overview-metrics article {
  display: grid;
  min-width: 0;
  gap: 3px;
  padding: 11px 13px;
  border-left: 1px solid var(--v2-overview-divider);
  background: var(--v2-overview-surface);
}

.v2-theme-components__overview-metrics article:first-child {
  border-left: 0;
}

.v2-theme-components__overview-metrics strong {
  color: var(--v2-overview-text);
  font-size: 19px;
  font-variant-numeric: tabular-nums;
}

.v2-theme-components__band {
  padding: 18px 0 20px;
  border-top: 1px solid var(--v2-border);
}

.v2-theme-components__band h2 {
  margin-bottom: 16px;
  font-size: 15px;
}

.v2-theme-components__form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 22px;
}

.v2-theme-components__wide {
  grid-column: 1 / -1;
}

.v2-theme-components__form-grid :deep(.el-select),
.v2-theme-components__form-grid :deep(.el-date-editor),
.v2-theme-components__form-grid :deep(.el-input-number) {
  width: 100%;
}

.v2-theme-components__choices,
.v2-theme-components__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 18px;
}

.v2-theme-components__pagination {
  justify-content: flex-end;
  padding-top: 14px;
}

@media (max-width: 640px) {
  .v2-theme-components.v2-shell {
    padding: 18px 12px;
  }

  .v2-theme-components__form-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .v2-theme-components__overview {
    grid-template-columns: minmax(0, 1fr);
    padding: 16px;
  }

  .v2-theme-components__wide {
    grid-column: auto;
  }

  .v2-theme-components__choices,
  .v2-theme-components__actions {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
