<template>
  <V2ConfirmDialog
    :model-value="modelValue"
    title="操作结果"
    message=""
    width="min(720px, 94vw)"
    :confirm-visible="false"
    cancel-text="关闭"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="online-result">
      <OnlineTaskProgress
        v-if="liveTask"
        :task="liveTask"
        :connected="tracker.connected.value"
        :error="tracker.error.value"
        @refresh="tracker.refresh"
      />
      <template v-for="entry in entries" :key="entry.label"
        ><h3>{{ entry.label }}</h3>
        <p>{{ entry.value }}</p></template
      >
      <AppButton v-if="copyValue" variant="soft" @click="copy">复制本次内容</AppButton>
      <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
      <div v-if="files.length" class="online-files">
        <article v-for="file in files" :key="file.id">
          <strong>{{ file.name }}</strong
          ><AppButton variant="soft" :loading="fileBusy === file.id" @click="openFile(file)"
            >查看文件</AppButton
          >
        </article>
      </div>
      <img v-if="mediaUrl && mediaKind === 'image'" :src="mediaUrl" alt="任务执行截图" />
      <video
        v-if="mediaUrl && mediaKind === 'video'"
        :src="mediaUrl"
        controls
        aria-label="任务执行录像"
      />
    </div>
  </V2ConfirmDialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { http } from '@/api/client';
import { copyOnlineText } from './api';
import { onlineLabel } from './labels';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import { useOnlineTask } from './useOnlineTask';
import type { PublicTask } from './contracts';
const props = defineProps<{ modelValue: boolean; result: unknown }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; copied: [] }>();
const labels: Record<string, string> = {
  message: '结果说明',
  id: '记录编号',
  taskId: '任务编号',
  status: '状态',
  progress: '进度',
  stage: '执行阶段',
  plan: '套餐',
  provider: '执行通道',
  operation: '操作类型',
  paymentStarted: '已开始付款',
  confirmedPaid: '已确认付款',
  email: '账号',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  amount: '实际金额',
  currency: '币种',
  cardLast4: '卡尾号',
  number: '银行卡号',
  cardNumber: '银行卡号',
  code: '兑换码',
  session: '会话资料',
  sessionPayload: '会话资料',
  checkoutUrl: '支付链接',
  url: '链接',
  autoRenew: '自动续费',
  expiresAt: '到期时间',
  subscriptionStatus: '订阅状态',
  imported: '已导入',
  duplicated: '重复数量',
  rejected: '未通过数量',
  count: '数量',
  successCount: '成功次数',
  declineCount: '拒付次数',
  totalAmount: '消费合计',
  records: '账单数量',
  inserted: '新增数量',
  duplicates: '重复数量',
  codes: '兑换码',
  content: '导出内容',
  result: '执行结果',
  events: '执行日志',
  logs: '执行日志',
  renewalStatus: '续费状态',
  data: '结果详情',
  balance: '供应商余额',
  total: '总数',
  mode: '运行模式',
  size: '槽位数量',
  available: '可用槽位',
  solver: '求解器状态',
  connected: '连接状态',
  active: '活动任务',
  tasks: '新建任务',
  orders: '最近供应商订单',
  balance_error: '余额查询错误',
  base_url: '供应商地址',
  credits: '可用积分',
  balance_usd: '美元余额',
  credit_plans: '积分套餐',
  plans: '可用套餐',
  error: '错误说明',
  ok: '检测通过',
  success: '执行通过',
  ready: '依赖就绪',
  enabled: '已启用',
  script_exists: '求解脚本存在',
  python: 'Python 程序',
  vlm_configured: '视觉模型已配置',
  no_vlm: '已禁用视觉模型',
  endpoint: '检测地址',
  model: '模型',
  latency_ms: '耗时（毫秒）',
  http_status: '响应状态码',
  response_preview: '响应摘要',
  apiUrl: '打码平台地址',
  autoFixed: '地址已自动修正',
  gptPlans: '供应商充值套餐',
  creditPlans: '供应商积分套餐',
  name: '名称',
  price: '价格',
  hasActiveSubscription: '有效订阅',
  remainingDaysDisplay: '剩余时长',
  subscriptionChannel: '订阅渠道',
  queriedAtDisplay: '查询时间',
  initialized: '已初始化',
  idle: '空闲槽位',
  busy: '占用槽位',
  browserVersion: '浏览器版本',
  results: '各项检测结果',
  proxyId: '代理编号',
  exitIp: '出口地址',
  latencyMs: '耗时（毫秒）'
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const resultRecord = computed(() => record(props.result));
const taskOperations = new Set([
  'recharge',
  'debug',
  'subscription',
  'renewal',
  'config_test',
  'proxy_test',
  'browser_manage',
  'notification',
  'recheck'
]);
const taskStatuses = new Set([
  'queued',
  'running',
  'awaiting_credentials',
  'awaiting_review',
  'succeeded',
  'failed',
  'cancelled'
]);
function resultTask(value: unknown): PublicTask | undefined {
  const item = record(value);
  return typeof item.id === 'string' &&
    taskOperations.has(String(item.operation)) &&
    taskStatuses.has(String(item.status))
    ? (item as unknown as PublicTask)
    : undefined;
}
const entries = computed(() => {
  if (Array.isArray(props.result))
    return [
      { label: '卡片消费汇总', value: summarize(props.result) || '暂无已确认成功的消费记录' }
    ];
  const details = resultTask(props.result)
    ? { ...resultRecord.value, ...liveTask.value }
    : resultRecord.value;
  return Object.entries(details)
    .filter(([key]) => labels[key] && !['cvc', 'taskToken', 'ticket'].includes(key))
    .map(([key, value]) => ({
      label: labels[key],
      value: displayValue(key, value)
    }));
});
function displayValue(key: string, value: unknown): string {
  if (value && typeof value === 'object') return summarize(value);
  return [
    'status',
    'plan',
    'provider',
    'operation',
    'subscriptionStatus',
    'renewalStatus',
    'autoRenew',
    'paymentStarted',
    'confirmedPaid'
  ].includes(key)
    ? onlineLabel(value)
    : String(value ?? '—');
}
function summarize(value: unknown): string {
  if (Array.isArray(value)) return value.map(summarize).join('\n\n');
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => labels[key])
      .map(([key, part]) => `${labels[key]}：${displayValue(key, part)}`)
      .join('\n');
  return onlineLabel(value);
}
const copyValue = computed(() =>
  String(
    resultRecord.value.code ??
      resultRecord.value.number ??
      resultRecord.value.cardNumber ??
      resultRecord.value.session ??
      resultRecord.value.sessionPayload ??
      resultRecord.value.checkoutUrl ??
      resultRecord.value.content ??
      ''
  )
);
const liveTask = ref<PublicTask>();
const tracker = useOnlineTask(liveTask, ref(''), false);
watch(
  () => [props.modelValue, props.result] as const,
  ([open, result]) => {
    liveTask.value = open ? (resultTask(result) ?? resultTask(record(result).task)) : undefined;
  },
  { immediate: true }
);
const copyStatus = ref('');
const mediaUrl = ref('');
const mediaKind = ref('');
const fileBusy = ref('');
interface FileRecord {
  id: string;
  name: string;
  kind: string;
  downloadPath?: string;
}
const files = computed(
  () =>
    (Array.isArray(resultRecord.value.files)
      ? resultRecord.value.files
      : Array.isArray(resultRecord.value.artifacts)
        ? resultRecord.value.artifacts
        : []) as FileRecord[]
);
function clear() {
  copyStatus.value = '';
  if (mediaUrl.value) URL.revokeObjectURL(mediaUrl.value);
  mediaUrl.value = '';
}
watch(() => props.modelValue, clear);
onBeforeUnmount(clear);
async function copy() {
  try {
    await copyOnlineText(copyValue.value);
    copyStatus.value = '已复制，请妥善保管';
    emit('copied');
  } catch {
    copyStatus.value = '复制失败，请手动选择内容';
  }
}
async function openFile(file: FileRecord) {
  fileBusy.value = file.id;
  try {
    const path =
      file.downloadPath ??
      `/id-business-v2/online-recharge/admin/artifacts/${encodeURIComponent(file.id)}`;
    if (!path.startsWith('/id-business-v2/online-recharge/')) throw new Error();
    const response = await http.get(path, { responseType: 'blob' });
    clear();
    mediaUrl.value = URL.createObjectURL(response.data);
    mediaKind.value = file.kind === 'video' ? 'video' : 'image';
  } catch {
    copyStatus.value = '文件读取失败，请重试';
  } finally {
    fileBusy.value = '';
  }
}
</script>
