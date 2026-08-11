<template>
  <section class="v2-governance-panel">
    <section class="v2-governance-command-panel" aria-label="治理任务筛选">
      <V2SectionHeading
        title="任务筛选"
        help="任务状态来自不可变预览、审批和分批执行记录；筛选不会修改任务状态。"
      >
        <template #actions>
          <span>{{
            page.jobQueryModel.type || page.jobQueryModel.status ? '已应用筛选' : '未附加筛选'
          }}</span>
        </template>
      </V2SectionHeading>

      <div class="v2-governance-filter-grid is-jobs">
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
        <div class="v2-governance-filter-grid__actions">
          <AppButton variant="ghost" :disabled="page.jobsLoading" @click="page.refreshJobs">
            <el-icon><Refresh /></el-icon>
            刷新任务
          </AppButton>
        </div>
      </div>

      <footer>
        <p>
          <el-icon aria-hidden="true"><InfoFilled /></el-icon>
          申请人只能取消自己的待审批任务；审批人必须是另一名管理员。
        </p>
        <span>每批最多执行 50 条</span>
      </footer>
    </section>

    <el-alert
      v-if="page.mutationError"
      type="error"
      :title="page.mutationError"
      :closable="false"
      show-icon
    />

    <V2AsyncRegion
      skeleton="table"
      :phase="page.jobsQueryPhase"
      :previous-data="page.jobsParameterTransition"
      :error="page.jobsError"
      loading-title="正在读取治理任务"
      refreshing-title="正在更新治理任务"
      error-title="治理任务加载失败"
      @retry="page.refreshJobs"
    >
      <section ref="listRef" class="v2-records-list v2-governance-list" :style="listFrameStyle">
        <header class="v2-governance-list__header">
          <V2SectionHeading
            title="治理任务"
            help="查看预览、审批人、分批结果和操作审计；可用操作继续由原任务状态和管理员身份决定。"
          >
            <template #actions>
              <V2TableColumnSettings inline :schema="v2TableSchemas.dataGovernance.jobs" />
              <span>本页 {{ page.jobs.length }} 条</span>
              <span aria-hidden="true">·</span>
              <strong>共 {{ page.jobsTotal }} 条</strong>
            </template>
          </V2SectionHeading>
        </header>

        <V2Table
          :schema="v2TableSchemas.dataGovernance.jobs"
          :data="page.jobs"
          :show-column-settings="false"
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
                <strong v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, 'jobNo']">
                  {{ job.jobNo }}
                </strong>
                <span v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '类型']">
                  {{ page.governanceJobTypeLabels[job.type] }}
                </span>
              </div>
              <el-tag
                v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '状态']"
                :type="page.governanceJobStatusMeta[job.status].type"
                effect="plain"
              >
                {{ page.governanceJobStatusMeta[job.status].label }}
              </el-tag>
            </header>
            <dl>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '申请人']">
                <dt>申请人</dt>
                <dd>{{ job.requestedBy.displayName }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '审批人']">
                <dt>审批人</dt>
                <dd>{{ job.approval?.approver.displayName ?? '—' }}</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '执行结果']">
                <dt>执行结果</dt>
                <dd>{{ job.succeededItems }}/{{ job.totalItems }} 成功</dd>
              </div>
              <div v-v2-column-visibility="[v2TableSchemas.dataGovernance.jobs.id, '创建时间']">
                <dt>创建时间</dt>
                <dd>{{ page.formatGovernanceDate(job.createdAt) }}</dd>
              </div>
            </dl>
            <footer>
              <AppButton size="small" variant="ghost" @click="page.openDetail(job)">
                查看详情
              </AppButton>
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
import { InfoFilled, Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import V2TableColumnSettings from '@/v2/components/V2TableColumnSettings.vue';
import { useV2StableListFrame } from '@/v2/composables/useV2StableListFrame';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ page: DataGovernancePage }>();
const { listRef, listFrameStyle } = useV2StableListFrame({
  items: () => props.page.jobs,
  pageSize: () => props.page.jobQueryModel.pageSize
});
</script>
