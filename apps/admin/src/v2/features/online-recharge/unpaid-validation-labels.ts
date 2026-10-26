import { formatV2DateTime } from '@/v2/utils/dateTime';
export function sessionProbeEntries(value: unknown): { label: string; value: string }[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const diagnostics = value as Record<string, unknown>;
  const handling: Record<string, string> = {
    cleared: '自动处理步骤已完成',
    solver_disabled: '自动验证未启用',
    not_actionable: '原页未确认可操作验证',
    failed: '自动验证未完成',
    timeout: '自动验证期限已到',
    session_invalid: '官网未接受登录资料'
  };
  const rows: { label: string; value: string }[] = [];
  for (const [key, label] of [
    ['initialSessionProbe', '首次会话核验'],
    ['homepageSessionProbe', '首页会话核验']
  ]) {
    const value = diagnostics[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const probe = value as Record<string, unknown>;
    const parts: string[] = [];
    if (
      typeof probe.httpStatus === 'number' &&
      Number.isInteger(probe.httpStatus) &&
      probe.httpStatus >= 100 &&
      probe.httpStatus <= 599
    )
      parts.push(`HTTP ${probe.httpStatus}`);
    const types: Record<string, string> = {
      'application/json': '结构化响应',
      'text/html': 'HTML页面',
      'text/plain': '纯文本',
      other: '其他内容类型',
      unknown: '内容类型未知'
    };
    const classes: Record<string, string> = {
      CF_CHALLENGE: '明确验证挑战',
      POLICY_OR_REGION_BLOCK: '地区或策略限制',
      AUTH_SESSION_REJECTED: '登录资料被拒绝',
      UNKNOWN_403: '拒绝原因未确认',
      NOT_CLASSIFIED: '未归类'
    };
    const states: Record<string, string> = {
      verified: '会话已核验',
      invalid: '会话无效',
      mismatch: '账号不一致',
      challenge: '需要官网验证',
      blocked: '会话读取被拒绝',
      timeout: '会话读取超时',
      network_error: '网络读取失败',
      unconfirmed: '会话未确认'
    };
    for (const [field, labels] of [
      ['contentType', types],
      ['classification', classes],
      ['state', states],
      ['automaticResult', handling]
    ] as const)
      if (typeof probe[field] === 'string' && labels[probe[field]])
        parts.push(labels[probe[field]]);
    if (['challenge', 'absent', 'unknown'].includes(String(probe.cfMitigated)))
      parts.push(
        `挑战响应头：${probe.cfMitigated === 'challenge' ? '明确挑战' : probe.cfMitigated === 'absent' ? '未提供' : '未知'}`
      );
    for (const [field, label] of [
      ['hasValidUser', '有效用户'],
      ['matchesTargetAccount', '目标账号匹配'],
      ['complete', '读取完整']
    ])
      if (typeof probe[field] === 'boolean') parts.push(`${label}：${probe[field] ? '是' : '否'}`);
    if (typeof probe.automaticAttempted === 'boolean')
      parts.push(probe.automaticAttempted ? '已调用自动处理器' : '未调用自动处理器');
    if (parts.length) rows.push({ label, value: parts.join('；') });
  }
  if (typeof diagnostics.automaticResult === 'string' && handling[diagnostics.automaticResult])
    rows.push({ label: '首页自动验证', value: handling[diagnostics.automaticResult] });
  return rows;
}
const stages: Record<string, string> = {
  input: '输入检查',
  proxy: '代理连接',
  login: '登录核验',
  preflight: '订阅前检',
  checkout_create: '创建结账单',
  checkout_open: '打开原结账单',
  card_readiness: '卡号控件检查',
  card_fill: '填写卡片',
  billing_fill: '填写账单',
  button_ready: '付款按钮检查',
  cleanup: '清理任务资源'
};
const outcomes: Record<string, string> = {
  ready_before_payment: '付款前就绪，未提交',
  failed_with_class: '已分类失败',
  challenge_blocked: '官网验证阻断，已结束'
};
const failures: Record<string, string> = {
  NONE: '无',
  INPUT_MISSING: '所需资料缺失或已失效',
  PROXY_UNAVAILABLE: '代理检查未通过',
  BROWSER_PROFILE_UNAVAILABLE: '专用浏览器不可用',
  LOGIN_READ_FAILED: '登录页面读取失败',
  LOGIN_UNCONFIRMED: '登录状态未确认',
  CHECKOUT_REJECTED: '官网拒绝建单',
  CHECKOUT_CREATION_UNKNOWN: '建单响应未确认，未重复创建',
  PAYMENT_COMPONENT_NOT_LOADED: '支付组件未加载',
  CARD_NOT_READY: '卡号控件或填写未就绪',
  BILLING_FILL_FAILED: '账单填写或回读失败',
  BUTTON_NOT_READY: '付款按钮未就绪',
  READ_INCOMPLETE: '控件读取未完成',
  CHALLENGE_BLOCKED: '官网验证未完成',
  EXECUTOR_INTERRUPTED: '执行器中断',
  OTHER: '其他执行异常，详见诊断'
};
const failureDetails: Record<string, string> = {
  CHECKOUT_CONTROL_BLOCKED: '控件交互前检查未通过',
  PROXY_CONNECTION_FAILED: '代理连通性检测已用尽5次，仍未完成核验，已停止后续操作',
  PROFILE_IDENTITY_MISSING: '缺少账号及用户标识，不能复用浏览器会话',
  PROFILE_PROXY_INVALID: '代理绑定格式无效，未继续执行',
  PROFILE_BUSY: '同一账号与代理的浏览器正在使用，本次未继续',
  PROFILE_EXIT_CHANGED: '代理出口与浏览器会话绑定不一致，已停止；未切换代理',
  PROFILE_BINDING_INVALID: '浏览器出口绑定记录无效，已停止',
  PROFILE_DIRECTORY_INVALID: '浏览器会话目录无效，已停止',
  PROFILE_LAUNCH_FAILED: '专用浏览器启动未完成，请检查运行环境',
  PROFILE_CLEANUP_FAILED: '浏览器关闭未确认，会话尚未释放'
};
const fields: Record<string, string> = {
  number: '卡号',
  expiry: '有效期',
  month: '有效月份',
  year: '有效年份',
  cvc: '安全码',
  country: '国家',
  line1: '街道',
  city: '城市',
  postal: '邮编',
  name: '姓名',
  state: '州省'
};
const pointReasons: Record<string, string> = {
  none: '位置检查通过',
  outside_viewport: '视口之外',
  occluded: '命中位置被遮挡',
  unsupported_transform: '页面变换无法核实',
  unsupported_geometry: '尺寸映射无法核实',
  control_ineligible: '控件不满足交互条件',
  frame_ineligible: '内嵌页面不满足交互条件',
  scroll_unavailable: '滚动未完成',
  page_changed: '控件或页面已变化'
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function diagnosticEntries(report: Record<string, unknown>) {
  const rows: { label: string; value: string }[] = [];
  const form = record(report.formDiagnostics),
    inspection = record(form.inspection);
  const failed = Array.isArray(form.steps)
    ? form.steps
        .map(record)
        .reverse()
        .find((step) => step.state === 'failed')
    : undefined;
  if (failed) {
    const phase: Record<string, string> = {
      locate: '定位',
      precheck: '交互前检查',
      input: '输入',
      readback: '填写后回读'
    };
    const tags: Record<string, string> = {
      input: '输入框',
      select: '原生下拉框',
      textarea: '多行输入框'
    };
    const parts = [
      fields[String(failed.field)],
      phase[String(failed.phase)],
      tags[String(failed.tag)],
      failed.frameKind === 'embedded' ? '内嵌页面' : failed.frameKind === 'main' ? '主页面' : ''
    ];
    rows.push({ label: '控件停止位置', value: parts.filter(Boolean).join('／') || '未确认' });
  }
  const interactions = Array.isArray(inspection.interactionChecks)
    ? inspection.interactionChecks.slice(-8).map(record)
    : [];
  const trace =
    [...interactions].reverse().find((item) => item.field === failed?.field) || interactions.at(-1);
  if (trace) {
    if (pointReasons[String(trace.initialReason)])
      rows.push({ label: '初始位置检查', value: pointReasons[String(trace.initialReason)] });
    const scroll = record(trace.scroll);
    const scrollErrors: Record<string, string> = {
      scroll_timeout: '单次滚动超时',
      node_detached: '控件已替换或脱离',
      frame_changed: '内嵌页面已变化',
      context_destroyed: '页面执行环境已替换',
      other: '其他滚动异常'
    };
    if (['completed', 'failed'].includes(String(scroll.state)))
      rows.push({
        label: '滚动结果',
        value: [
          scroll.state === 'completed' ? '已完成' : '未完成',
          scrollErrors[String(scroll.errorClass)],
          Number.isInteger(scroll.durationMs) ? `${scroll.durationMs} 毫秒` : ''
        ]
          .filter(Boolean)
          .join('／')
      });
    if (pointReasons[String(trace.afterScrollReason)])
      rows.push({ label: '滚动后位置检查', value: pointReasons[String(trace.afterScrollReason)] });
    const recovery: Record<string, string> = {
      requested: '已请求重定位',
      ready: '重新定位后可交互',
      read_incomplete: '重新定位读取未完成',
      blocked: '重新定位后仍未通过'
    };
    if (recovery[String(trace.recovery)])
      rows.push({ label: '重新定位结果', value: recovery[String(trace.recovery)] });
    if (Array.isArray(trace.pointChecks))
      trace.pointChecks
        .slice(-8)
        .map(record)
        .forEach((point, index) => {
          if (!pointReasons[String(point.reason)]) return;
          const scope =
            point.scope === 'control'
              ? '控件本身'
              : point.scope === 'frame_owner' && Number.isInteger(point.depth)
                ? `第 ${point.depth} 层内嵌页面外框`
                : '位置层级未确认';
          const geometry = record(point.geometry);
          const numbers = ['left', 'top', 'width', 'height', 'viewportWidth', 'viewportHeight'];
          const bounded = numbers.every(
            (key) =>
              typeof geometry[key] === 'number' &&
              Number.isInteger(geometry[key]) &&
              Math.abs(Number(geometry[key])) <= 1000000
          );
          rows.push({
            label: `位置观测 ${index + 1}`,
            value: `${scope}：${pointReasons[String(point.reason)]}${
              bounded
                ? `；左 ${geometry.left}、上 ${geometry.top}，尺寸 ${geometry.width}×${geometry.height}，视口 ${geometry.viewportWidth}×${geometry.viewportHeight}`
                : ''
            }`
          });
        });
  }
  const reasons: Record<string, string> = {
    timeout: '上传超时',
    network_error: '内部连接失败',
    http_error: '内部接口返回异常状态',
    response_invalid: '内部接口回执无法确认',
    lease_lost: '任务租约已失效',
    operation_rejected: '内部接口未接受',
    file_unavailable: '文件读取或准备失败',
    path_rejected: '文件路径未通过核验',
    file_rejected: '文件类型或大小未通过核验',
    deadline_exhausted: '本批附件上传期限已耗尽',
    unknown: '上传异常，具体原因未确认'
  };
  const kinds: Record<string, string> = {
    screenshot: '截图',
    video: '录像',
    diagnostic: '不付款诊断',
    batch: '附件批次'
  };
  if (Array.isArray(report.evidenceUploads))
    report.evidenceUploads
      .slice(-32)
      .map(record)
      .filter((row) => ['failed', 'skipped'].includes(String(row.outcome)))
      .slice(-4)
      .forEach((row, index) => {
        const parts = [
          kinds[String(row.kind)] || '附件',
          reasons[String(row.reason)] || '原因未确认',
          Number.isInteger(row.httpStatus) &&
          Number(row.httpStatus) >= 100 &&
          Number(row.httpStatus) <= 599
            ? `HTTP ${row.httpStatus}`
            : '',
          Number.isInteger(row.durationMs) ? `${row.durationMs} 毫秒` : '',
          Number.isInteger(row.remainingFiles) ? `剩余 ${row.remainingFiles} 个文件` : ''
        ];
        rows.push({ label: `附件上传异常 ${index + 1}`, value: parts.filter(Boolean).join('／') });
      });
  return rows;
}
export function unpaidValidationEntries(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const report = value as Record<string, unknown>;
  if (report.format !== 'unpaid-validation-v1') return [];
  const rows = [
    { label: '不付款验收结果', value: outcomes[String(report.outcome)] ?? '结果未确认' },
    { label: '最后执行阶段', value: stages[String(report.lastStage)] ?? '阶段未确认' },
    {
      label: '停止分类',
      value:
        failureDetails[String(report.failureCode)] ??
        failures[String(report.failureClass)] ??
        '分类未确认'
    },
    { label: '卡片回读', value: report.cardVerified === true ? '通过' : '尚未通过' },
    { label: '账单回读', value: report.billingVerified === true ? '通过' : '尚未通过' },
    { label: '付款按钮', value: report.buttonReady === true ? '已就绪，未点击' : '尚未确认就绪' },
    {
      label: '诊断文件',
      value: report.diagnosticUploaded === true ? '已保存' : '保存未确认，详见任务结果'
    }
  ];
  if (Array.isArray(report.missing) && report.missing.length) {
    rows.push({
      label: '未就绪字段',
      value: report.missing.map((key) => fields[String(key)] || '未知字段').join('、')
    });
  }
  if (Number.isInteger(report.httpStatus))
    rows.push({ label: '官网建单响应', value: `HTTP ${report.httpStatus}` });
  rows.push(...sessionProbeEntries(report.bootstrapDiagnostics), ...diagnosticEntries(report));
  if (Array.isArray(report.timeline))
    report.timeline.slice(0, 32).forEach((item, index) => {
      if (!item || typeof item !== 'object' || !stages[item.stage]) return;
      const elapsed = Date.parse(item.endedAt) - Date.parse(item.startedAt);
      rows.push({
        label: `阶段 ${index + 1}：${stages[item.stage]}`,
        value: `${formatV2DateTime(item.startedAt)}，${Number.isFinite(elapsed) ? Math.max(0, elapsed) : '未知'} 毫秒`
      });
    });
  return rows;
}
