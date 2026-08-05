<template>
  <section class="v2-governance-panel">
    <div class="v2-records-toolbar v2-governance-jobs-toolbar">
      <el-select
        v-model="page.jobQueryModel.type"
        clearable
        placeholder="全部任务类型"
        aria-label="筛选任务类型"
        @change="page.handleJobFilterChange"
      >
        <el-option
          v-for="(label, value) in page.governanceJobTypeLabels"
          :key="value"
          :label="label"
          :value="value"
        />
      </el-select>
      <el-select
        v-model="page.jobQueryModel.status"
        clearable
        placeholder="全部任务状态"
        aria-label="筛选任务状态"
        @change="page.handleJobFilterChange"
      >
        <el-option
          v-for="(meta, value) in page.governanceJobStatusMeta"
          :key="value"
          :label="meta.label"
          :value="value"
        />
      </el-select>
      <div class="v2-records-toolbar__actions">
        <AppButton icon-only title="刷新" :disabled="page.jobsLoading" @click="page.refreshJobs">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </div>

    <el-alert
      v-if="page.mutationError"
      type="error"
      :title="page.mutationError"
      :closable="false"
      show-icon
    />

    <V2AsyncRegion
      skeleton="table"
      :loading="page.jobsLoading"
      :resolved="page.jobsHasData"
      :error="page.jobsError"
      loading-title="正在读取治理任务"
      refreshing-title="正在更新治理任务"
      error-title="治理任务加载失败"
      @retry="page.refreshJobs"
    >
      <section class="v2-records-list">
        <V2Table
          :schema="v2TableSchemas.dataGovernance.jobs"
          :data="page.jobs"
          class="v2-records-table"
          scrollbar-always-on
          show-overflow-tooltip
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无治理任务</strong>
              <span>可从回收站或受控清理入口生成影响预览</span>
            </div>
          </template>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[0]" prop="jobNo" />
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[1]">
            <template #default="{ row }">{{ page.governanceJobTypeLabel(row.type) }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[2]">
            <template #default="{ row }">
              <el-tag :type="page.getGovernanceJobStatusMeta(row.status).type" effect="plain">
                {{ page.getGovernanceJobStatusMeta(row.status).label }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[3]">
            <template #default="{ row }">
              {{ row.succeededItems }}/{{ row.totalItems }} 成功
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[4]">
            <template #default="{ row }">{{ row.requestedBy.displayName }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[5]">
            <template #default="{ row }">{{ row.approval?.approver.displayName ?? '—' }}</template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[6]">
            <template #default="{ row }">{{ page.formatGovernanceDate(row.createdAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.dataGovernance.jobs.columns[7]">
            <template #default="{ row }">
              <AppButton size="small" variant="ghost" @click="page.openDetail(row)">详情</AppButton>
              <AppButton
                v-if="page.canApprove(row)"
                size="small"
                variant="ghost"
                @click="page.openDecisionDrawer(row)"
              >
                审批
              </AppButton>
              <AppButton
                v-if="page.canCancel(row)"
                size="small"
                variant="danger"
                :loading="page.mutationBusy === `cancel:${row.id}`"
                @click="page.cancelJob(row)"
              >
                取消任务
              </AppButton>
              <AppButton
                v-if="row.status === 'approved'"
                size="small"
                variant="primary"
                :loading="page.mutationBusy === `execute:${row.id}`"
                @click="page.executeJob(row)"
              >
                执行下一批
              </AppButton>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <div
          class="v2-records-mobile-list"
          :data-mobile-for="v2TableSchemas.dataGovernance.jobs.id"
        >
          <article v-for="job in page.jobs" :key="job.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ job.jobNo }}</strong>
                <span>{{ page.governanceJobTypeLabels[job.type] }}</span>
              </div>
              <el-tag :type="page.governanceJobStatusMeta[job.status].type" effect="plain">
                {{ page.governanceJobStatusMeta[job.status].label }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>申请人</dt>
                <dd>{{ job.requestedBy.displayName }}</dd>
              </div>
              <div>
                <dt>审批人</dt>
                <dd>{{ job.approval?.approver.displayName ?? '—' }}</dd>
              </div>
              <div>
                <dt>执行结果</dt>
                <dd>{{ job.succeededItems }}/{{ job.totalItems }} 成功</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{{ page.formatGovernanceDate(job.createdAt) }}</dd>
              </div>
            </dl>
            <footer>
              <AppButton size="small" variant="ghost" @click="page.openDetail(job)"
                >查看详情</AppButton
              >
              <AppButton
                v-if="page.canApprove(job)"
                size="small"
                variant="ghost"
                @click="page.openDecisionDrawer(job)"
              >
                审批
              </AppButton>
              <AppButton
                v-if="page.canCancel(job)"
                size="small"
                variant="danger"
                :loading="page.mutationBusy === `cancel:${job.id}`"
                @click="page.cancelJob(job)"
              >
                取消任务
              </AppButton>
              <AppButton
                v-if="job.status === 'approved'"
                size="small"
                variant="primary"
                :loading="page.mutationBusy === `execute:${job.id}`"
                @click="page.executeJob(job)"
              >
                执行下一批
              </AppButton>
            </footer>
          </article>
          <div v-if="!page.jobs.length" class="v2-records-empty">
            <strong>暂无治理任务</strong>
            <span>可从回收站或受控清理入口生成影响预览</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>当前筛选共 {{ page.jobsTotal }} 条</span>
          <el-pagination
            v-model:current-page="page.jobQueryModel.page"
            v-model:page-size="page.jobQueryModel.pageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="page.jobsTotal"
            @current-change="page.refreshJobs"
            @size-change="page.handleJobFilterChange"
          />
        </footer>
      </section>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

defineProps<{ page: DataGovernancePage }>();
</script>

<style scoped>
.v2-governance-panel {
  display: grid;
  gap: 14px;
}

.v2-governance-jobs-toolbar {
  grid-template-columns: minmax(180px, 240px) minmax(180px, 240px) 1fr;
}

@media (max-width: 760px) {
  .v2-governance-jobs-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
