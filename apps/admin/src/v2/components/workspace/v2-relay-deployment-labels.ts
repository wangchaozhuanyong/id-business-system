import type {
  V2RelayDeploymentMode,
  V2RelayJobStatus,
  V2RelayJobStep
} from '@apple-business/shared';

export const V2_RELAY_MODE_DESCRIPTIONS: Record<V2RelayDeploymentMode, string> = {
  antigravity_subscription: '授权 Gemini 订阅号，同步参考账号模型并逐个验收。',
  gemini_api: '固定部署 Gemini 3.7 文本与 Gemini 3.1 TTS，先官方直测再入站。',
  vertex: '创建 Google Cloud 项目和服务账号，复制 Vertex 参考模型白名单。'
};

const MODE_LABELS: Record<V2RelayDeploymentMode, string> = {
  antigravity_subscription: 'Gemini 订阅号',
  gemini_api: 'AI Studio API Key',
  vertex: 'Vertex AI'
};

const STATUS_LABELS: Record<V2RelayJobStatus, string> = {
  draft: '待执行',
  running: '执行中',
  action_required: '待人工授权',
  completed: '已完成',
  failed: '执行失败'
};

const STEP_LABELS: Record<V2RelayJobStep, string> = {
  authorize_account: '授权订阅号并创建不可调度账号',
  set_privacy: '设置 Antigravity 隐私状态',
  sync_models: '同步实时模型目录',
  configure_models: '保存模型映射和调度参数',
  verify_provider_models: '验证 API Key 可用模型',
  test_provider_text: '官方直测 Gemini 3.7 文本',
  test_provider_tts: '官方直测 Gemini 3.1 TTS',
  create_project: '创建或确认 Google 项目',
  link_billing: '绑定结算账号',
  enable_services: '启用 Google Cloud API',
  create_service_account: '创建服务账号',
  grant_permissions: '授予 Vertex 权限',
  create_service_account_key: '创建并加密保存服务账号密钥',
  create_cloudbridge_account: '创建中转站不可调度账号',
  test_models: '逐模型验收',
  attach_group: '加入正式分组并启用调度'
};

export function v2RelayModeLabel(mode: V2RelayDeploymentMode) {
  return MODE_LABELS[mode];
}

export function v2RelayJobStatusLabel(status: V2RelayJobStatus) {
  return STATUS_LABELS[status];
}

export function v2RelayStepLabel(step: V2RelayJobStep) {
  return STEP_LABELS[step];
}
