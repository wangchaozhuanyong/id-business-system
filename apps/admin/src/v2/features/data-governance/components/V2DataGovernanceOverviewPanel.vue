<template>
  <V2AsyncRegion
    skeleton="cards"
    :loading="page.overviewLoading"
    :resolved="page.overviewHasData"
    :error="page.overviewError"
    loading-title="正在读取治理概况"
    refreshing-title="正在更新治理概况"
    error-title="治理概况加载失败"
    @retry="page.refreshOverview"
  >
    <div v-if="page.overview" class="v2-governance-overview">
      <section class="v2-governance-metrics" aria-label="回收站概况">
        <article>
          <span>回收站总数</span>
          <strong>{{ page.overview.recycleBin.total }}</strong>
          <small>仅统计软删除记录</small>
        </article>
        <article v-for="(label, entity) in page.recycleEntityLabels" :key="entity">
          <span>{{ label }}</span>
          <strong>{{ page.overview.recycleBin.byEntity[entity] }}</strong>
          <small>待复核恢复</small>
        </article>
      </section>

      <section class="v2-governance-safety">
        <header>
          <div>
            <strong>安全边界</strong>
            <span>当前能力与仍需外部验证的边界</span>
          </div>
          <el-tag
            :type="page.overview.approvalReadiness.ready ? 'success' : 'danger'"
            effect="plain"
          >
            {{ page.overview.approvalReadiness.ready ? '审批工作流可执行' : '审批工作流阻塞' }}
          </el-tag>
        </header>
        <el-alert
          v-if="!page.overview.approvalReadiness.ready"
          type="error"
          :title="page.overview.approvalReadiness.blockedReason ?? '异人审批条件未就绪'"
          :description="`当前启用管理员 ${page.overview.approvalReadiness.activeAdminCount} 人，可作为其他审批人的管理员 ${page.overview.approvalReadiness.eligibleApproverCount} 人。`"
          :closable="false"
          show-icon
        />
        <div class="v2-governance-capability-grid">
          <article v-for="capability in page.overview.capabilities" :key="capability.key">
            <div>
              <strong>{{ capability.title }}</strong>
              <el-tag
                :type="
                  capability.status === 'available'
                    ? 'success'
                    : capability.status === 'blocked'
                      ? 'danger'
                      : 'info'
                "
                effect="plain"
                size="small"
              >
                {{
                  capability.status === 'available'
                    ? '可用'
                    : capability.status === 'blocked'
                      ? '阻塞'
                      : '待验证'
                }}
              </el-tag>
            </div>
            <p>{{ capability.detail }}</p>
          </article>
        </div>
      </section>

      <section class="v2-governance-workflow">
        <header>
          <strong>执行闭环</strong>
          <span>通用业务数据硬删除：关闭</span>
        </header>
        <ol>
          <li v-for="(step, index) in page.overview.proposedWorkflow" :key="step">
            <span>{{ index + 1 }}</span>
            <strong>{{ step }}</strong>
          </li>
        </ol>
        <footer>
          <span>最近汇率清理审计</span>
          <strong>{{
            page.formatGovernanceDate(page.overview.existingRetention.lastAuditedRunAt)
          }}</strong>
        </footer>
      </section>
    </div>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

defineProps<{ page: DataGovernancePage }>();
</script>

<style scoped>
.v2-governance-overview {
  display: grid;
  gap: 14px;
}

.v2-governance-metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.v2-governance-metrics article,
.v2-governance-safety,
.v2-governance-workflow {
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-governance-metrics article {
  display: grid;
  gap: 6px;
  padding: 16px;
}

.v2-governance-metrics span,
.v2-governance-metrics small,
.v2-governance-safety header span,
.v2-governance-workflow header span,
.v2-governance-workflow footer span {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-governance-metrics strong {
  color: var(--v2-text);
  font-size: 26px;
}

.v2-governance-safety,
.v2-governance-workflow {
  display: grid;
  gap: 14px;
  padding: 16px;
}

.v2-governance-safety > header,
.v2-governance-workflow > header,
.v2-governance-workflow > footer,
.v2-governance-capability-grid article > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-governance-safety > header > div {
  display: grid;
  gap: 4px;
}

.v2-governance-capability-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.v2-governance-capability-grid article {
  padding: 14px;
  border-radius: var(--v3-radius);
  background: var(--v2-surface-soft);
}

.v2-governance-capability-grid p {
  margin: 8px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-governance-workflow ol {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.v2-governance-workflow li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border-radius: var(--v3-radius);
  background: var(--v2-surface-soft);
  font-size: 12px;
}

.v2-governance-workflow li span {
  display: grid;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

@media (max-width: 900px) {
  .v2-governance-metrics,
  .v2-governance-capability-grid,
  .v2-governance-workflow ol {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 560px) {
  .v2-governance-metrics,
  .v2-governance-capability-grid,
  .v2-governance-workflow ol {
    grid-template-columns: 1fr;
  }
}
</style>
