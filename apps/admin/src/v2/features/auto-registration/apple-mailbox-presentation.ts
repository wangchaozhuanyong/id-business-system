import type {
  AppleMailboxRegistrationStatus,
  AppleMailboxTaskStatus,
  AppleMailboxRow,
  AppleMailboxMarkInput,
  AppleMailboxSyncStatus,
  AppleMailboxRecord
} from './contracts';

export const appleMailboxStatusOptions: Array<{
  value: AppleMailboxRegistrationStatus;
  label: string;
}> = [
  { value: 'unknown', label: '待确认' },
  { value: 'unregistered', label: '未注册' },
  { value: 'registered', label: '已注册' }
];

export function appleMailboxStatusLabel(value: AppleMailboxRegistrationStatus) {
  return appleMailboxStatusOptions.find((option) => option.value === value)?.label ?? '待确认';
}

export function appleMailboxTaskLabel(value: AppleMailboxTaskStatus | null) {
  if (!value) return '暂无任务';
  return {
    pending: '等待执行',
    running: '正在注册',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '中断待核对',
    awaiting_review: '结果待核对'
  }[value];
}

export function appleMailboxSyncLabel(value?: AppleMailboxSyncStatus) {
  if (!value || value === 'not_ready') return '尚未具备同步条件';
  return {
    not_started: '尚未开始同步',
    awaiting_identity: '等待身份核验',
    blocked: '同步条件未满足',
    quarantined: '迟到结果隔离待核对',
    pending: '等待同步',
    syncing: '正在同步',
    saved: '已同步到 ChatGPT 账号',
    failed: '同步失败，可仅补同步',
    conflict: '账号冲突，等待核对'
  }[value];
}

export function appleMailboxCanSync(value?: AppleMailboxSyncStatus) {
  return value === 'pending' || value === 'failed' || value === 'awaiting_identity';
}

export function appleMailboxCanResumeAuthorization(value?: {
  creationConfirmed?: boolean;
  authorizationStatus?: 'pending' | 'complete' | null;
  activeTaskUuid?: string | null;
  taskStatus: AppleMailboxTaskStatus | null;
  taskUuid?: string | null;
  lastTaskUuid?: string | null;
}) {
  return Boolean(
    value?.creationConfirmed &&
    value.authorizationStatus === 'pending' &&
    (value.taskUuid || value.lastTaskUuid) &&
    !value.activeTaskUuid &&
    !appleMailboxTaskActive(value.taskStatus)
  );
}

export function appleMailboxAuthorizationLabel(value: AppleMailboxRecord['authorizationStatus']) {
  return value === 'complete' ? '授权已完成' : value === 'pending' ? '官网已创建·待授权' : '';
}

export function appleMailboxManualSyncPreviewLabel(
  value: import('./contracts').AppleMailboxManualSyncPreview['items'][number]['status']
) {
  return {
    create: '将新增为已注册·待补资料',
    exists: '台账已有记录，保留现有资料',
    conflict: '已有同邮箱账号，需核对来源',
    deleted: '台账记录在回收站，需先核对',
    busy: '邮箱有未结束任务，暂不处理',
    stale: '邮箱状态已变化，请刷新后重新选择',
    ineligible: '仅同步人工标记为已注册的邮箱'
  }[value];
}

export function appleMailboxCanSaveLocal(
  value: AppleMailboxRecord['localSaveStatus'],
  status: AppleMailboxTaskStatus | null
) {
  return (
    (value === 'pending' || value === 'failed') &&
    status !== null &&
    !appleMailboxTaskActive(status)
  );
}

export function appleMailboxLocalSaveLabel(value: AppleMailboxRecord['localSaveStatus']) {
  return value === 'saved'
    ? '自动注册账号已保存'
    : value === 'failed'
      ? '自动注册账号保存失败'
      : value === 'pending'
        ? '等待保存自动注册账号'
        : '自动注册账号尚未保存';
}

export function appleMailboxIdentityLabel(value: AppleMailboxRecord['identityStatus']) {
  return value === 'verified'
    ? '账号身份已核验'
    : value === 'mismatch'
      ? '账号身份不符，等待核对'
      : '账号身份尚未核验';
}

export function appleMailboxDiagnostic(
  record?: Pick<AppleMailboxRecord, 'stage' | 'reason' | 'syncErrorKind' | 'firstFailure'>
) {
  if (!record) return '';
  const stages: Record<string, string> = {
    queued: '等待执行',
    sentinel: '注册前置校验',
    signup: '提交注册表单',
    verification_code: '邮箱验证码',
    verification_validate: '验证邮箱验证码',
    password: '注册密码提交',
    create_account: '创建官网账号',
    workspace: '读取账号工作区',
    select_workspace: '选择账号工作区',
    redirect: '授权跳转',
    oauth: '注册后授权',
    account_save: '自动注册账号保存',
    identity: '账号身份核验',
    sync: 'ChatGPT 账号同步'
  };
  const reasons: Record<string, string> = {
    account_creation_failed: '官网返回账号创建失败，请核对原任务结果',
    email_conflict: '已有同邮箱账号，来源冲突',
    deleted_account: '关联账号已删除，请核对原记录',
    storage_unavailable: '账号存储暂时不可用',
    sync_failed: '主账号同步失败',
    identity_missing: '缺少可核验的账号身份',
    identity_mismatch: '注册账号与任务邮箱不符',
    local_save_failed: '自动注册本地账号保存失败',
    payload_invalid: '账号保存资料不完整',
    password_missing: '缺少原注册密码，等待核对',
    existing_account_suspected: '官网提示可能已有账号，等待身份核验'
  };
  const reason = record.reason || record.syncErrorKind;
  const current = [
    record.stage ? stages[record.stage] || '注册后处理' : '',
    reason ? reasons[reason] || '执行结果需核对，请查看任务记录' : ''
  ]
    .filter(Boolean)
    .join(' · ');
  const failure = record.firstFailure;
  if (!failure) return current;
  const errors = {
    http_rejected: '服务返回失败',
    network_error: '网络请求异常',
    unknown: '执行结果待核对',
    account_creation_failed: '官网返回账号创建失败',
    user_exists: '官网提示已有账号，需核验身份'
  };
  return [
    `首次失败：${failure.stage === 'queued' ? '注册初始化' : stages[failure.stage] || '执行步骤待核对'} · ${errors[failure.errorKind] || '执行结果待核对'}`,
    failure.httpStatus === null ? '未取得响应状态' : `响应状态 ${failure.httpStatus}`,
    `耗时 ${failure.elapsedMs / 1000} 秒`,
    current ? `当前：${current}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

export function appleMailboxSelectionLabel(
  record?: Pick<AppleMailboxRecord, 'mailboxSelection' | 'proxySource' | 'proxyId'>
) {
  if (!record) return '';
  const selection =
    record.mailboxSelection === 'automatic'
      ? '自动选择邮箱'
      : record.mailboxSelection === 'specified'
        ? '指定邮箱'
        : '';
  const proxy =
    record.proxySource === 'system'
      ? `系统代理${record.proxyId ? `（编号 ${record.proxyId}）` : ''}`
      : record.proxySource === 'explicit'
        ? '手工代理配置'
        : record.proxySource === 'default'
          ? '系统默认代理配置'
          : '';
  return [selection, proxy].filter(Boolean).join(' · ');
}

export function appleMailboxSourceLabel(source: AppleMailboxRow['source']) {
  return source === 'manual'
    ? '人工标记'
    : source === 'automatic'
      ? '注册任务'
      : source === 'account_history'
        ? '历史账号记录'
        : '未标记';
}

export function appleMailboxIpSourceLabel(source: AppleMailboxRow['registrationIpSource']) {
  return source === 'observed' ? '任务检测出口' : source === 'manual' ? '人工填写' : '来源未记录';
}

export function appleMailboxTaskActive(status: AppleMailboxTaskStatus | null) {
  return status === 'pending' || status === 'running';
}

export function appleMailboxNeedsReview(
  row: Pick<AppleMailboxRow, 'activeTaskUuid' | 'taskStatus'>
) {
  // 旧接口未返回占用编号时仍保留保护；已解除占用的历史状态不再阻止人工标记。
  return (
    row.activeTaskUuid !== null &&
    (row.taskStatus === 'interrupted' || row.taskStatus === 'awaiting_review')
  );
}

export function appleMailboxCanRecover(
  row: Pick<AppleMailboxRow, 'taskUuid' | 'activeTaskUuid' | 'taskStatus'>
) {
  return Boolean(row.taskUuid) && appleMailboxNeedsReview(row);
}

export function appleMailboxBusy(row: AppleMailboxRow) {
  return (
    appleMailboxTaskActive(row.taskStatus) ||
    Boolean(row.activeTaskUuid) ||
    appleMailboxNeedsReview(row)
  );
}

export function appleMailboxRegisterReason(row: AppleMailboxRow) {
  if (appleMailboxTaskActive(row.taskStatus)) return '该邮箱已有执行中的任务';
  if (appleMailboxNeedsReview(row)) return '请先查看任务，人工核对后解除占用并标记注册状态';
  if (row.activeTaskUuid) return '邮箱仍被原任务占用，请先核对任务状态';
  if (row.registrationStatus === 'registered') return '该邮箱已注册，不能再次注册';
  if (row.registrationStatus !== 'unregistered') return '请先确认并标记为未注册';
  if (row.mailboxStatus !== 'ACTIVE') return '隐藏邮箱已停用';
  if (!row.primaryAvailable) return '所属主邮箱不可用';
  if (!row.authorizationValid) return '邮箱查询授权已失效';
  return row.canRegister ? '' : row.blockedReason || '当前邮箱暂时不能注册';
}

export function isAppleMailboxIp(value: string) {
  if (!value) return true;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value))
    return value.split('.').every((part) => Number(part) <= 255);
  if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function appleMailboxMarkError(input: AppleMailboxMarkInput) {
  if (!input.items.length) return '请选择需要标记的邮箱';
  if (!appleMailboxStatusOptions.some((item) => item.value === input.registrationStatus))
    return '请选择注册状态';
  if (input.registrationIp && !isAppleMailboxIp(input.registrationIp))
    return '请填写有效的 IPv4 或 IPv6 地址';
  if (input.note.length > 500) return '备注不能超过 500 个字';
  return '';
}

/** Only closed labels and bounded status numbers reach the task detail. */
export function appleMailboxFlowEvidenceRows(value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('version' in value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3)
  )
    return [];
  const evidence = value as Record<string, unknown>;
  const label = (labels: Record<string, string>, item: unknown, fallback: string) =>
    typeof item === 'string' && Object.hasOwn(labels, item) ? labels[item]! : fallback;
  return (
    [
      ['authorize', '授权入口'],
      ...(evidence.version === 3 ? [['sentinel', '注册前置校验'] as const] : []),
      ['signup', '提交注册邮箱'],
      ['password', '提交注册密码']
    ] as const
  ).map(([stage, title]) => {
    const candidate = evidence[stage];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return { stage, title, status: '尚未观察', detail: '尚未取得该阶段的流程证据' };
    const row = candidate as Record<string, unknown>;
    const status = label(
      { accepted: '已确认继续', rejected: '已停止，等待核对', observed: '已观察，不代表注册成功' },
      row.decision,
      '观察结果待核对'
    );
    const details = [
      Number.isInteger(row.httpStatus) &&
      Number(row.httpStatus) >= 100 &&
      Number(row.httpStatus) <= 599
        ? `响应状态 ${row.httpStatus}`
        : '未取得响应状态',
      row.officialOrigin === true ? '官网来源已确认' : '官网来源未确认',
      label(
        {
          json: '响应类型：结构化数据',
          html: '响应类型：网页',
          other: '响应类型：其他',
          missing: '响应类型：未记录'
        },
        row.contentType,
        '响应类型：待核对'
      ),
      label(
        {
          object: '数据结构：对象',
          other: '数据结构：非对象',
          invalid: '数据结构：解析失败',
          not_checked: '数据结构：未检查'
        },
        row.jsonKind,
        '数据结构：待核对'
      ),
      label(
        {
          new_account: '页面类型：新账号注册',
          existing_account: '页面类型：已有账号',
          missing: '页面类型：缺失',
          unknown: '页面类型：未知',
          not_checked: '页面类型：未检查'
        },
        row.pageKind,
        '页面类型：待核对'
      )
    ];
    if (row.reason !== null) {
      details.push(
        label(
          {
            http_status: '响应状态不符合预期',
            untrusted_origin: '来源未通过校验',
            invalid_json: '响应不是预期的结构化数据',
            upstream_error: '官网响应携带错误',
            unexpected_page: '页面类型与预期不符',
            challenge_required: '官网要求额外验证，当前流程已停止',
            challenge_invalid: '官网验证要求无法确认',
            missing_token: '未取得官网验证凭据'
          },
          row.reason,
          '判断原因待核对'
        )
      );
    }
    if (
      ((evidence.version === 2 && stage === 'signup') ||
        (evidence.version === 3 && (stage === 'signup' || stage === 'password'))) &&
      row.responseDetails &&
      typeof row.responseDetails === 'object' &&
      !Array.isArray(row.responseDetails)
    ) {
      const response = row.responseDetails as Record<string, unknown>;
      const shapes = {
        missing: '未提供',
        null: '空值',
        object: '对象',
        string: '文本',
        list: '列表',
        boolean: '布尔值',
        number: '数字',
        other: '其他'
      };
      details.push(
        label(
          {
            none: '响应错误：未携带错误',
            error: '响应错误：携带单项错误',
            errors: '响应错误：携带错误集合',
            both: '响应错误：同时携带两类错误'
          },
          response.errorSignal,
          '响应错误：待核对'
        ),
        `单项错误结构：${label(shapes, response.errorShape, '待核对')}`,
        `错误集合结构：${label(shapes, response.errorsShape, '待核对')}`,
        label(
          {
            none: '上游错误分类：无',
            account_creation_failed: '上游错误分类：拒绝创建账号',
            user_exists: '上游错误分类：账号已存在',
            other: '上游错误分类：其他'
          },
          response.errorKind,
          '上游错误分类：待核对'
        )
      );
      if (stage === 'signup') {
        details.push(
          label(
            {
              missing: '页面结构异常：未提供页面信息',
              non_object: '页面结构异常：页面信息不是对象',
              type_missing: '页面结构异常：缺少页面类型',
              type_non_string: '页面结构异常：页面类型不是文本',
              type_known: '页面结构：类型已识别',
              type_unknown: '未知页面：类型尚未识别'
            },
            response.pageShape,
            '页面结构：待核对'
          )
        );
      }
      if (evidence.version === 3 && response.pageShape === 'type_unknown') {
        details.push(
          typeof response.pageTypeSha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(response.pageTypeSha256)
            ? '未知页面标识摘要已记录'
            : '未知页面标识摘要未记录'
        );
      }
    }
    if (evidence.version === 3 && stage === 'password' && row.pageKind === 'missing') {
      details[4] = '此阶段未要求页面类型';
    }
    if (
      evidence.version === 3 &&
      stage === 'sentinel' &&
      row.sentinelDetails &&
      typeof row.sentinelDetails === 'object' &&
      !Array.isArray(row.sentinelDetails)
    ) {
      const challenge = row.sentinelDetails as Record<string, unknown>;
      const required = {
        required: '官网要求',
        not_required: '官网未要求',
        missing: '官网未说明',
        invalid: '要求格式无效'
      };
      details.push(
        challenge.tokenPresent === true
          ? '官网验证凭据：已取得'
          : challenge.tokenPresent === false
            ? '官网验证凭据：未取得'
            : '官网验证凭据：待核对',
        `额外计算验证：${label(required, challenge.proofOfWorkRequired, '待核对')}`,
        `交互验证：${label(required, challenge.turnstileRequired, '待核对')}`
      );
    }
    if (Array.isArray(row.redirectHosts) && row.redirectHosts.length) {
      const hosts = row.redirectHosts.slice(0, 5).map((host) =>
        label(
          {
            auth_openai: '官网授权服务',
            sentinel_openai: '官网安全服务',
            chatgpt: '官网账号服务',
            other: '其他来源'
          },
          host,
          '来源待核对'
        )
      );
      details.push(
        `跳转来源：${hosts.join('、')}${row.redirectsTruncated === true ? '（仅记录前段）' : ''}`
      );
    }
    details.push(row.requestIdPresent === true ? '请求标识已记录' : '未记录请求标识');
    return { stage, title, status, detail: details.join(' · ') };
  });
}
