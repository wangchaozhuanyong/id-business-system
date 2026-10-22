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
      <OnlineHumanVerification
        v-if="
          modelValue &&
          liveTask?.status === 'running' &&
          liveTask.stage === 'human_verification' &&
          canVerify
        "
        :key="liveTask.id"
        :task-id="liveTask.id"
      />
      <section v-if="orderSync" aria-label="充值订单同步">
        <h3>订单同步</h3>
        <p>
          {{ syncLabels[orderSync.status] ?? '待核对'
          }}<span v-if="orderSync.orderNo"> · {{ orderSync.orderNo }}</span>
        </p>
        <RouterLink
          v-if="orderSync.orderNo && canReadOrders"
          :to="{
            path: '/v2/auto-recharge/bank-orders',
            query: { channel: 'online', orderNo: orderSync.orderNo }
          }"
          @click="$emit('update:modelValue', false)"
          >查看线上订单</RouterLink
        >
        <AppButton
          v-if="
            canSyncOrder && orderSync.status !== 'synced' && orderSync.status !== 'not_applicable'
          "
          variant="soft"
          :loading="syncBusy"
          @click="syncOrder"
          >补同步订单</AppButton
        >
        <p v-if="syncMessage" role="status">{{ syncMessage }}</p>
      </section>
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
import { proxyCountryLabel } from '@/v2/features/proxy-pool/public-api';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { http } from '@/api/client';
import { copyOnlineText, onlineApi } from './api';
import { useAuthStore } from '@/stores/auth';
import { canReadOnlineOrders, canManageOnlineOrders } from './orderPermissions';
import { onlineChangeEntries, onlineFailureLabel, onlineLabel } from './labels';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import OnlineHumanVerification from './OnlineHumanVerification.vue';
import { canUseOnlineAction } from './permissions';
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
  subscriptionChange: '套餐变更与官网报价',
  planRegion: '本次套餐地区',
  sourcePlan: '变更前套餐',
  targetPlan: '目标套餐',
  kind: '开通方式',
  provider: '执行通道',
  operation: '操作类型',
  paymentStarted: '已开始付款',
  confirmedPaid: '已确认付款',
  querySucceeded: '订阅查询成功',
  queryError: '订阅查询失败原因',
  queryErrorCode: '订阅查询结果',
  diagnostics: '查询网络诊断',
  queryDiagnostics: '订阅查询网络诊断',
  compareDiagnostics: '只读对照结果（不替代订阅核验）',
  transport: '读取方式',
  phase: '查询阶段',
  attempt: '读取次数',
  elapsedMs: '总耗时（毫秒）',
  httpStatus: '官网响应状态码',
  statusCode: '查询响应状态码',
  networkCode: '网络结果',
  requestIssued: '请求已发出',
  responseHeadersReceived: '已收到响应头',
  responseBodyCompleted: '响应体已读取完成',
  headersElapsedMs: '等待响应头（毫秒）',
  bodyElapsedMs: '读取响应体（毫秒）',
  responseElapsedMs: '等待完整响应（毫秒）',
  timeoutSource: '停止原因',
  failurePhase: '停止位置',
  cancellationConfirmed: '请求停止已确认',
  accountFactsPresent: '已取得账号资料',
  accountIdentityMatches: '账号身份一致',
  skippedReason: '未执行对照的原因',
  errorCode: '失败原因',
  paymentVerified: '付款证据已核实',
  paymentEvidence: '原单付款证据',
  confirmation: '账号与套餐核验',
  verified: '核验通过',
  observedPlan: '查询到的套餐',
  tierVerified: '套餐档位已核实',
  reconciliationReason: '原单核对结果',
  email: '账号',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  amount: '金额',
  amountMeaning: '金额说明',
  billingSummary: '卡片消费汇总',
  knownAmount: '已知金额小计',
  knownAmountCount: '金额已知笔数',
  unknownAmountCount: '金额待核对笔数',
  isComplete: '金额是否完整',
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
interface OrderSync {
  status: 'pending' | 'synced' | 'needs_review' | 'not_applicable';
  orderId?: string;
  orderNo?: string;
  errorCode?: string;
}
const auth = useAuthStore();
const synced = ref<OrderSync>();
const syncBusy = ref(false),
  syncMessage = ref('');
const syncLabels: Record<OrderSync['status'], string> = {
  pending: '等待同步',
  synced: '已同步订单',
  needs_review: '同步待人工核对',
  not_applicable: '此任务不生成充值订单'
};
const orderSync = computed(
  () =>
    synced.value ??
    ((record(resultRecord.value.orderSync).status
      ? resultRecord.value.orderSync
      : record(resultRecord.value.task).orderSync) as OrderSync | undefined)
);
const canReadOrders = computed(() => canReadOnlineOrders(auth.user));
const canSyncOrder = computed(() => canManageOnlineOrders(auth.user));
const canVerify = computed(() => canUseOnlineAction(auth.user, 'jobs', 'human-verification'));
watch(
  () => props.result,
  () => {
    synced.value = undefined;
    syncMessage.value = '';
  }
);
async function syncOrder() {
  const id = String(resultRecord.value.id ?? record(resultRecord.value.task).id ?? '');
  if (!id || syncBusy.value || !canSyncOrder.value) return;
  syncBusy.value = true;
  syncMessage.value = '';
  try {
    const value = await onlineApi.action('jobs', 'sync-order', { id });
    if (String(resultRecord.value.id ?? record(resultRecord.value.task).id ?? '') !== id) return;
    synced.value = value as unknown as OrderSync;
    syncMessage.value = '已提交订单同步；不会重新充值或付款。';
  } catch {
    syncMessage.value = '订单同步失败，请稍后重试。';
  } finally {
    syncBusy.value = false;
  }
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
    .filter(
      ([key]) =>
        labels[key] &&
        !['cvc', 'taskToken', 'ticket'].includes(key) &&
        !(key === 'result' && ['queued', 'running'].includes(liveTask.value?.status ?? ''))
    )
    .map(([key, value]) => ({
      label: resultLabel(key, value),
      value: displayValue(key, value)
    }));
});
function displayValue(key: string, value: unknown): string {
  if (key === 'networkCode') {
    if (value == null) return '—';
    const meanings: Record<string, string> = {
      ETIMEDOUT: '读取超时',
      ECONNRESET: '连接被重置',
      ECONNREFUSED: '连接被拒绝',
      ENOTFOUND: '域名未找到',
      EAI_AGAIN: '域名暂时无法解析',
      ECONNABORTED: '连接已中止',
      'net::ERR_TIMED_OUT': '浏览器读取超时',
      'net::ERR_CONNECTION_RESET': '浏览器连接被重置',
      'net::ERR_PROXY_CONNECTION_FAILED': '代理连接失败',
      'net::ERR_TUNNEL_CONNECTION_FAILED': '代理隧道连接失败',
      'net::ERR_ABORTED': '浏览器请求已取消',
      'net::ERR_FAILED': '浏览器网络读取失败'
    };
    return meanings[String(value)] ?? '网络读取未完成';
  }
  if (['transport', 'phase', 'timeoutSource', 'failurePhase', 'skippedReason'].includes(key)) {
    const meanings: Record<string, string> = {
      'browser-page': '当前已登录浏览器',
      'proxy-request': '任务代理请求',
      'context-request-compare': '同一会话的只读对照',
      account_check: '读取账号订阅',
      request_dispatch: '发送请求',
      response_headers: '等待官网响应头',
      response_body: '读取官网响应体',
      request_complete: '等待官网完整响应',
      attempt_deadline: '单次读取到期',
      query_deadline: '查询总期限到期',
      lease_lost: '任务执行权已失效',
      browser_abort: '浏览器请求已取消',
      shared_context: '当前浏览器由其他流程共用',
      cancellation_unconfirmed: '前次请求尚未确认停止',
      deadline_exhausted: '剩余时间不足'
    };
    return value == null ? '—' : (meanings[String(value)] ?? '本次未能确认');
  }
  if (key === 'paymentEvidence' && record(value).verified !== true)
    return '尚未取得绑定原单的付款证据';
  if (key === 'code' && /^(VLM_|VERIFICATION_)/.test(String(value)))
    return onlineFailureLabel(value);
  if (['errorCode', 'queryErrorCode', 'reconciliationReason'].includes(key))
    return onlineFailureLabel(value);
  if (key === 'planRegion' && value && typeof value === 'object') {
    const route = value as Record<string, unknown>;
    return `代理国家：${proxyCountryLabel(String(route.proxyCountryCode ?? ''))}\n支付地区：${proxyCountryLabel(String(route.paymentRegion ?? ''))}\n预期结算币种：${String(route.expectedCurrency ?? '—')}\n规则版本：${String(route.configVersion ?? '—')}`;
  }
  if (key === 'subscriptionChange')
    return onlineChangeEntries({ subscriptionChange: value })
      .map((entry) => `${entry.label}：${entry.value}`)
      .join('\n');
  if (value && typeof value === 'object') return summarize(value);
  return [
    'status',
    'stage',
    'plan',
    'sourcePlan',
    'targetPlan',
    'kind',
    'provider',
    'operation',
    'subscriptionStatus',
    'renewalStatus',
    'autoRenew',
    'isComplete',
    'paymentStarted',
    'confirmedPaid',
    'querySucceeded',
    'paymentVerified',
    'verified',
    'observedPlan',
    'tierVerified',
    'requestIssued',
    'responseHeadersReceived',
    'responseBodyCompleted',
    'cancellationConfirmed',
    'accountFactsPresent',
    'accountIdentityMatches'
  ].includes(key)
    ? onlineLabel(value)
    : String(value ?? '—');
}
function resultLabel(key: string, value: unknown): string {
  return key === 'code' && /^(VLM_|VERIFICATION_)/.test(String(value)) ? '检测结果' : labels[key];
}
function summarize(value: unknown): string {
  if (Array.isArray(value)) return value.map(summarize).join('\n\n');
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => labels[key] && key !== 'subscriptionChange')
      .map(([key, part]) => `${resultLabel(key, part)}：${displayValue(key, part)}`)
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
