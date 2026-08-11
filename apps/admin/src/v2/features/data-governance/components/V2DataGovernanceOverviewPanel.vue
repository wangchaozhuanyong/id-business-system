<template>
  <V2AsyncRegion
    skeleton="cards"
    :phase="page.overviewQueryPhase"
    :error="page.overviewError"
    loading-title="正在读取治理概况"
    refreshing-title="正在更新治理概况"
    error-title="治理概况加载失败"
    @retry="page.refreshOverview"
  >
    <section v-if="page.overview" class="v2-governance-overview-workspace">
      <article class="v2-governance-surface v2-governance-capabilities">
        <header>
          <V2SectionHeading
            title="治理能力"
            help="只展示当前系统已实现或仍需验证的能力，不把未知状态描述为正常。"
          >
            <template #actions>
              <span>{{ availableCount }} 项可用</span>
              <span aria-hidden="true">·</span>
              <strong>{{ page.overview.capabilities.length }} 项能力</strong>
            </template>
          </V2SectionHeading>
        </header>
        <div class="v2-governance-capability-list">
          <article v-for="capability in page.overview.capabilities" :key="capability.key">
            <el-icon aria-hidden="true"
              ><CircleCheck v-if="capability.status === 'available'" /><WarningFilled v-else
            /></el-icon>
            <div>
              <strong>{{ capability.title }}</strong>
              <p>{{ capability.detail }}</p>
            </div>
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
          </article>
        </div>
      </article>

      <article class="v2-governance-surface v2-governance-boundary">
        <header>
          <V2SectionHeading
            title="审批与保护边界"
            help="新预览必须有另一名启用管理员可以审批，通用业务数据硬删除始终关闭。"
          >
            <template #actions>
              <el-tag
                :type="page.overview.approvalReadiness.ready ? 'success' : 'danger'"
                effect="plain"
              >
                {{ page.overview.approvalReadiness.ready ? '审批可执行' : '审批阻塞' }}
              </el-tag>
            </template>
          </V2SectionHeading>
        </header>
        <el-alert
          v-if="!page.overview.approvalReadiness.ready"
          type="error"
          :title="page.overview.approvalReadiness.blockedReason ?? '异人审批条件未就绪'"
          :closable="false"
          show-icon
        />
        <dl class="v2-governance-boundary-list">
          <div>
            <dt>启用管理员</dt>
            <dd>{{ page.overview.approvalReadiness.activeAdminCount }} 人</dd>
          </div>
          <div>
            <dt>其他可审批管理员</dt>
            <dd>{{ page.overview.approvalReadiness.eligibleApproverCount }} 人</dd>
          </div>
          <div>
            <dt>恢复预览</dt>
            <dd>{{ page.overview.safety.restoreEnabled ? '已启用' : '已关闭' }}</dd>
          </div>
          <div>
            <dt>汇率历史清理</dt>
            <dd>{{ page.overview.safety.cleanupEnabled ? '已启用' : '已关闭' }}</dd>
          </div>
          <div>
            <dt>通用硬删除</dt>
            <dd class="is-safe">关闭</dd>
          </div>
          <div>
            <dt>最近清理审计</dt>
            <dd>
              {{ page.formatGovernanceDate(page.overview.existingRetention.lastAuditedRunAt) }}
            </dd>
          </div>
        </dl>
      </article>

      <article class="v2-governance-surface v2-governance-workflow">
        <header>
          <V2SectionHeading
            title="执行闭环"
            help="预览、审批与执行使用同一预览哈希；每个条目独立事务并保留检查点和审计编号。"
          >
            <template #actions>
              <span>{{ page.overview.timezone }}</span>
              <span aria-hidden="true">·</span>
              <strong>通用硬删除关闭</strong>
            </template>
          </V2SectionHeading>
        </header>
        <ol>
          <li v-for="(step, index) in page.overview.proposedWorkflow" :key="step">
            <el-icon aria-hidden="true"><CircleCheck /></el-icon>
            <div>
              <span>步骤 {{ index + 1 }}</span>
              <strong>{{ step }}</strong>
            </div>
          </li>
        </ol>
      </article>
    </section>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { CircleCheck, WarningFilled } from '@element-plus/icons-vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ page: DataGovernancePage }>();
const availableCount = computed(
  () => props.page.overview?.capabilities.filter((item) => item.status === 'available').length ?? 0
);
</script>
