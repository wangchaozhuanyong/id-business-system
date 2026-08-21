<template>
  <div v-if="page.overview" class="v2-system-details">
    <template v-if="page.activeSection === 'operations'">
      <section class="v2-system-details__panel" aria-label="认证聚合快照">
        <V2SectionHeading title="认证聚合快照" help="仅展示聚合计数，不返回账号、IP 或设备信息。">
          <template #actions>
            <el-tag
              :type="page.systemMonitorStatusMeta(page.overview.authAvailability.status).type"
              effect="plain"
            >
              {{ page.systemMonitorStatusMeta(page.overview.authAvailability.status).label }}
            </el-tag>
          </template>
        </V2SectionHeading>
        <dl class="v2-system-details__metrics">
          <div>
            <dt>24 小时登录</dt>
            <dd>{{ display(page.overview.authentication.attempts) }}</dd>
          </div>
          <div>
            <dt>失败或阻断</dt>
            <dd>{{ display(page.overview.authentication.failed) }}</dd>
          </div>
          <div>
            <dt>异常标记</dt>
            <dd>{{ display(page.overview.authentication.abnormal) }}</dd>
          </div>
          <div>
            <dt>有效会话</dt>
            <dd>{{ display(page.overview.authentication.activeSessions) }}</dd>
          </div>
          <div>
            <dt>5 分钟认证不可用率</dt>
            <dd>{{ formatRate(page.overview.authAvailability.unavailableRate) }}</dd>
          </div>
          <div>
            <dt>连续不可用</dt>
            <dd>{{ page.overview.authAvailability.consecutiveUnavailable }}</dd>
          </div>
        </dl>
      </section>

      <section class="v2-system-details__panel" aria-label="汇率任务证据">
        <V2SectionHeading
          title="汇率任务证据"
          help="状态来自数据库设置和最近运行，不代表外部平台始终可用。"
        >
          <template #actions>
            <el-tag effect="plain">{{ exchangeModeLabel }}</el-tag>
          </template>
        </V2SectionHeading>
        <dl class="v2-system-details__metrics">
          <div>
            <dt>运行能力</dt>
            <dd>{{ exchangeModeLabel }}</dd>
          </div>
          <div>
            <dt>自动采集</dt>
            <dd>{{ autoExchangeLabel }}</dd>
          </div>
          <div>
            <dt>最近运行</dt>
            <dd>
              {{ page.exchangeRunStatusLabel(page.overview.exchangeRate?.latestRun?.status) }}
            </dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>
              {{
                page.formatSystemMonitoringDate(page.overview.exchangeRate?.latestRun?.startedAt)
              }}
            </dd>
          </div>
          <div>
            <dt>安全错误码</dt>
            <dd>{{ page.overview.exchangeRate?.latestRun?.errorCode || '—' }}</dd>
          </div>
          <div>
            <dt>下次计划</dt>
            <dd>
              {{ page.formatSystemMonitoringDate(page.overview.exchangeRate?.settings?.nextRunAt) }}
            </dd>
          </div>
        </dl>
      </section>

      <section class="v2-system-details__panel" aria-label="收购汇率任务证据">
        <V2SectionHeading
          title="收购汇率任务证据"
          help="监控免费供应商配置、每日任务、异常审核和最新有效报价时间。"
        >
          <template #actions>
            <el-tag
              :type="page.overview.purchaseRate?.providerConfigured ? 'success' : 'danger'"
              effect="plain"
            >
              {{ page.overview.purchaseRate?.providerConfigured ? '供应商已配置' : '供应商未配置' }}
            </el-tag>
          </template>
        </V2SectionHeading>
        <dl class="v2-system-details__metrics">
          <div>
            <dt>自动采集</dt>
            <dd>
              {{ page.overview.purchaseRate?.settings?.autoEnabled ? '已启用' : '已停用或未知' }}
            </dd>
          </div>
          <div>
            <dt>最近批次</dt>
            <dd>
              {{ page.exchangeRunStatusLabel(page.overview.purchaseRate?.latestRun?.status) }}
            </dd>
          </div>
          <div>
            <dt>异常币种</dt>
            <dd>
              {{ page.overview.purchaseRate?.latestRun?.abnormalCurrencyCodes.join('、') || '无' }}
            </dd>
          </div>
          <div>
            <dt>最新报价时间</dt>
            <dd>
              {{ page.formatSystemMonitoringDate(page.overview.purchaseRate?.latestSnapshotAt) }}
            </dd>
          </div>
          <div>
            <dt>过期阈值</dt>
            <dd>{{ page.overview.purchaseRate?.settings?.staleMinutes ?? '—' }} 分钟</dd>
          </div>
          <div>
            <dt>下次计划</dt>
            <dd>
              {{ page.formatSystemMonitoringDate(page.overview.purchaseRate?.settings?.nextRunAt) }}
            </dd>
          </div>
        </dl>
      </section>

      <section class="v2-system-details__boundary">
        <el-icon aria-hidden="true"><InfoFilled /></el-icon>
        <div>
          <strong>只读运行边界</strong>
          <p>本页不启停任务、不修改设置、不下线会话；所有内容都来自受保护的只读聚合接口。</p>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="v2-system-gaps" aria-label="当前不可观测项">
        <V2SectionHeading
          title="当前不可观测项"
          help="未知不等于正常，也不等于故障；接入可信证据后才能判定。"
        >
          <template #actions>
            <span>共 {{ page.overview.observabilityGaps.length }} 项</span>
          </template>
        </V2SectionHeading>

        <div v-if="page.overview.observabilityGaps.length" class="v2-system-gaps__grid">
          <article v-for="(gap, index) in page.overview.observabilityGaps" :key="gap.key">
            <header>
              <span>{{ String(index + 1).padStart(2, '0') }}</span>
              <el-tag type="info" effect="plain">未知</el-tag>
            </header>
            <strong>{{ gap.title }}</strong>
            <p>{{ gap.detail }}</p>
          </article>
        </div>
        <div v-else class="v2-system-monitoring-empty">
          <strong>当前没有声明中的可观测缺口</strong>
          <span>这不代表所有运行证据已完整，仍应以服务端结果为准。</span>
        </div>
      </section>

      <section class="v2-system-gaps__meaning">
        <div>
          <span>未知</span>
          <strong>没有足够的可信证据</strong>
        </div>
        <p>不把缺少证据解释为“正常”，也不直接解释为“故障”，避免给管理员错误安全感。</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { InfoFilled } from '@element-plus/icons-vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;

const props = defineProps<{ page: SystemMonitoringPage }>();

function display(value: number | null) {
  return value === null ? '未知' : value;
}

function formatRate(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

const exchangeModeLabel = computed(() =>
  props.page.overview?.exchangeRate?.executionMode === 'automatic_capable'
    ? '支持自动执行'
    : props.page.overview?.exchangeRate
      ? '仅人工模式'
      : '未知'
);

const autoExchangeLabel = computed(() => {
  const settings = props.page.overview?.exchangeRate?.settings;
  if (!settings) return '未知';
  return settings.autoEnabled ? '已启用' : '已停用';
});
</script>
