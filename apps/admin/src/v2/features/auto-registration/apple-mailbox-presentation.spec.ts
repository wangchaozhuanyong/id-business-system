import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isAutoRegistrationPage } from './bridge';
import {
  appleMailboxPage,
  type AppleMailboxRow,
  type AppleMailboxFlowObservation,
  type AppleMailboxFlowResponseDetails
} from './contracts';
import {
  appleMailboxIpSourceLabel,
  appleMailboxMarkError,
  appleMailboxRegisterReason,
  appleMailboxSourceLabel,
  appleMailboxStatusLabel,
  appleMailboxTaskLabel,
  isAppleMailboxIp,
  appleMailboxSyncLabel,
  appleMailboxCanSync,
  appleMailboxDiagnostic,
  appleMailboxSelectionLabel,
  appleMailboxCanSaveLocal,
  appleMailboxBusy,
  appleMailboxCanRecover,
  appleMailboxCanResumeAuthorization,
  appleMailboxAuthorizationLabel,
  appleMailboxManualSyncPreviewLabel,
  appleMailboxFlowEvidenceRows
} from './apple-mailbox-presentation';

const row: AppleMailboxRow = {
  aliasId: 'alias-1',
  email: 'hidden@example.invalid',
  primaryEmail: 'primary@example.invalid',
  mailboxStatus: 'ACTIVE',
  authorizationValid: true,
  primaryAvailable: true,
  registrationStatus: 'unregistered',
  registrationIp: null,
  registrationIpSource: null,
  note: null,
  source: 'manual',
  updatedAt: null,
  revision: 1,
  taskUuid: null,
  taskStatus: null,
  canRegister: true,
  blockedReason: null
};

describe('苹果隐藏邮箱注册边界与中文展示', () => {
  it('官网创建和授权完成分别展示，人工注册标记不能冒充可恢复任务', () => {
    const created = {
      ...row,
      taskUuid: 'task-1',
      creationConfirmed: true,
      authorizationStatus: 'pending' as const,
      taskStatus: 'failed' as const
    };
    expect(appleMailboxCanResumeAuthorization(row)).toBe(false);
    expect(appleMailboxCanResumeAuthorization(created)).toBe(true);
    expect(appleMailboxCanResumeAuthorization({ ...created, activeTaskUuid: 'task-1' })).toBe(
      false
    );
    expect(appleMailboxCanResumeAuthorization({ ...created, taskStatus: 'running' })).toBe(false);
    expect(
      appleMailboxCanResumeAuthorization({ ...created, authorizationStatus: 'complete' })
    ).toBe(false);
    expect(appleMailboxAuthorizationLabel('pending')).toBe('官网已创建·待授权');
    expect(appleMailboxAuthorizationLabel('complete')).toBe('授权已完成');
    expect(appleMailboxManualSyncPreviewLabel('exists')).toContain('保留现有资料');
  });
  it('显示首次失败快照，不把前序成功或当前同步步骤当成失败位置', () => {
    const text = appleMailboxDiagnostic({
      stage: 'sync',
      reason: 'identity_missing',
      firstFailure: {
        stage: 'create_account',
        errorKind: 'account_creation_failed',
        httpStatus: 400,
        elapsedMs: 1500,
        observedAt: '2026-10-11T00:00:00Z'
      }
    });
    expect(text).toContain('首次失败：创建官网账号');
    expect(text).toContain('响应状态 400');
    expect(text).toContain('耗时 1.5 秒');
    expect(text).toContain('当前：ChatGPT 账号同步');
    expect(text).not.toContain('account_creation_failed');
  });
  it('授权网络异常明确没有响应状态，工作区步骤中文显示', () => {
    const text = appleMailboxDiagnostic({
      firstFailure: {
        stage: 'select_workspace',
        errorKind: 'network_error',
        httpStatus: null,
        elapsedMs: 0,
        observedAt: '2026-10-11T00:00:00Z'
      }
    });
    expect(text).toContain('首次失败：选择账号工作区');
    expect(text).toContain('未取得响应状态');
    expect(text).not.toContain('200');
    expect(appleMailboxDiagnostic({ stage: 'redirect' })).toBe('授权跳转');
  });
  it('选择来源仅显示安全的代理目录编号，旧记录不补造来源', () => {
    expect(
      appleMailboxSelectionLabel({
        mailboxSelection: 'automatic',
        proxySource: 'system',
        proxyId: 'proxy-1'
      })
    ).toBe('自动选择邮箱 · 系统代理（编号 proxy-1）');
    expect(
      appleMailboxSelectionLabel({
        mailboxSelection: 'specified',
        proxySource: 'default',
        proxyId: null
      })
    ).toBe('指定邮箱 · 系统默认代理配置');
    expect(appleMailboxSelectionLabel({})).toBe('');
  });
  it('同步和注册事实独立，待身份核验不显示成功或自动重注册入口', () => {
    expect(appleMailboxSyncLabel('saved')).toContain('已同步');
    expect(appleMailboxSyncLabel('awaiting_identity')).toBe('等待身份核验');
    expect(appleMailboxSyncLabel('quarantined')).toContain('隔离');
    expect(appleMailboxCanSync('awaiting_identity')).toBe(true);
    expect(appleMailboxCanSync('conflict')).toBe(false);
    expect(appleMailboxCanSync('saved')).toBe(false);
    expect(appleMailboxCanSync('failed')).toBe(true);
    expect(appleMailboxCanSaveLocal('failed', 'running')).toBe(false);
    expect(appleMailboxCanSaveLocal('failed', 'failed')).toBe(true);
    expect(
      appleMailboxDiagnostic({ stage: 'create_account', reason: 'account_creation_failed' })
    ).toContain('官网返回账号创建失败');
    expect(
      appleMailboxDiagnostic({ stage: 'identity', reason: 'existing_account_suspected' })
    ).toContain('等待身份核验');
  });
  it('结果待核对提示人工核对后解除；旧接口保持保护，释放后的历史状态不再阻止标记', () => {
    expect(appleMailboxRegisterReason({ ...row, taskStatus: 'awaiting_review' })).toContain(
      '人工核对后解除占用'
    );
    expect(appleMailboxRegisterReason({ ...row, taskStatus: 'interrupted' })).toContain('解除占用');
    for (const taskStatus of ['interrupted', 'awaiting_review'] as const) {
      const reviewing = { ...row, taskUuid: 'task-1', taskStatus };
      expect(appleMailboxBusy(reviewing)).toBe(true);
      expect(appleMailboxCanRecover(reviewing)).toBe(true);
      expect(appleMailboxBusy({ ...reviewing, activeTaskUuid: null })).toBe(false);
      expect(appleMailboxCanRecover({ ...reviewing, activeTaskUuid: null })).toBe(false);
      expect(appleMailboxRegisterReason({ ...reviewing, activeTaskUuid: null })).toBe('');
    }
    expect(
      appleMailboxCanRecover({
        ...row,
        taskUuid: 'task-1',
        activeTaskUuid: 'task-1',
        taskStatus: 'running'
      })
    ).toBe(false);
    expect(appleMailboxBusy({ ...row, activeTaskUuid: 'task-1' })).toBe(true);
    expect(appleMailboxRegisterReason({ ...row, activeTaskUuid: 'task-1' })).not.toBe('');
  });
  it('自有页签不加入上游 iframe 页面白名单', () => {
    expect(appleMailboxPage.title).toBe('苹果隐藏邮箱');
    expect(isAutoRegistrationPage(appleMailboxPage.path)).toBe(false);
  });
  it('仅允许已确认未注册、可用、未占用且服务器允许的邮箱注册', () => {
    expect(appleMailboxRegisterReason(row)).toBe('');
    for (const patch of [
      { registrationStatus: 'unknown' },
      { registrationStatus: 'registered' },
      { mailboxStatus: 'DISABLED' },
      { authorizationValid: false },
      { primaryAvailable: false },
      { taskStatus: 'pending' },
      { taskStatus: 'running' },
      { taskStatus: 'interrupted' },
      { canRegister: false }
    ])
      expect(appleMailboxRegisterReason({ ...row, ...patch } as AppleMailboxRow)).not.toBe('');
    expect(
      appleMailboxRegisterReason({ ...row, canRegister: false, blockedReason: '后台任务已占用' })
    ).toBe('后台任务已占用');
  });
  it.each([
    '',
    '0.0.0.0',
    '203.0.113.10',
    '255.255.255.255',
    '::1',
    '2001:db8::1',
    '::ffff:192.0.2.1'
  ])('允许空值及合法 IP：%s', (value) => expect(isAppleMailboxIp(value)).toBe(true));
  it.each([
    'example.com',
    '01.2.3.4',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4:80',
    '2001:::1',
    'fe80::1%en0',
    'http://203.0.113.10',
    '<script>'
  ])('拒绝无效 IP 或非 IP 地址：%s', (value) => expect(isAppleMailboxIp(value)).toBe(false));
  it('人工历史标记允许未知 IP，拒绝空选择和超长备注', () => {
    const input = {
      items: [{ aliasId: row.aliasId, revision: row.revision }],
      registrationStatus: 'registered' as const,
      registrationIp: null,
      note: ''
    };
    expect(appleMailboxMarkError(input)).toBe('');
    expect(appleMailboxMarkError({ ...input, items: [] })).toContain('请选择');
    expect(appleMailboxMarkError({ ...input, registrationIp: 'invalid' })).toContain('IPv4');
    expect(appleMailboxMarkError({ ...input, note: '字'.repeat(501) })).toContain('500');
  });
  it('所有状态、标记来源和 IP 证据均映射中文', () => {
    expect(appleMailboxStatusLabel('unknown')).toBe('待确认');
    expect(appleMailboxStatusLabel('registered')).toBe('已注册');
    expect(appleMailboxTaskLabel('interrupted')).toBe('中断待核对');
    expect(appleMailboxTaskLabel(null)).toBe('暂无任务');
    expect(appleMailboxSourceLabel(null)).toBe('未标记');
    expect(appleMailboxSourceLabel('manual')).toBe('人工标记');
    expect(appleMailboxSourceLabel('automatic')).toBe('注册任务');
    expect(appleMailboxIpSourceLabel('observed')).toBe('任务检测出口');
    expect(appleMailboxIpSourceLabel('manual')).toBe('人工填写');
  });
});

const flowObservation: AppleMailboxFlowObservation = {
  observedAt: '2026-10-16T00:00:00.000Z',
  httpStatus: 200,
  contentType: 'json',
  jsonKind: 'object',
  pageKind: 'new_account',
  officialOrigin: true,
  redirectHosts: ['auth_openai'],
  redirectsTruncated: false,
  requestIdPresent: true,
  requestIdSha256: 'a'.repeat(64),
  decision: 'accepted',
  reason: null
};
const flowResponseDetails: AppleMailboxFlowResponseDetails = {
  errorSignal: 'none',
  errorShape: 'missing',
  errorsShape: 'missing',
  errorKind: 'none',
  pageShape: 'type_known'
};
function iframeFlowRows(value: unknown) {
  const source = readFileSync(
    new URL(
      '../../../../../../apps/api/src/id-business-v2/auto-registration/worker/id-workspace.js',
      import.meta.url
    ),
    'utf8'
  );
  const start = source.indexOf('  function registrationFlowEvidenceRows(');
  const end = source.indexOf('  function installAppleConsole()', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const execute = runInNewContext(
    source.slice(start, end) + '\nregistrationFlowEvidenceRows',
    Object.create(null)
  );
  return JSON.parse(JSON.stringify(execute(value)));
}

describe('注册任务流程证据的封闭中文展示', () => {
  it('三阶段使用同型字段，观察和继续均不冒充注册成功', () => {
    const evidence = {
      version: 1,
      authorize: { ...flowObservation, jsonKind: 'not_checked', pageKind: 'not_checked' },
      signup: flowObservation,
      password: { ...flowObservation, decision: 'observed', pageKind: 'not_checked' }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows.map((row) => row.title)).toEqual(['授权入口', '提交注册邮箱', '提交注册密码']);
    expect(rows[0]?.status).toBe('已确认继续');
    expect(rows[1]?.detail).toContain('页面类型：新账号注册');
    expect(rows[2]?.status).toBe('已观察，不代表注册成功');
    expect(rows[0]?.detail).toContain('官网来源已确认');
    expect(rows[0]?.detail).not.toContain('a'.repeat(64));
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it('兼容没有证据的旧任务，有新结构时明确区分尚未观察阶段', () => {
    for (const value of [undefined, null, {}, { version: 4 }, { version: '2' }, []]) {
      expect(appleMailboxFlowEvidenceRows(value)).toEqual([]);
      expect(iframeFlowRows(value)).toEqual([]);
    }
    const evidence = { version: 1, authorize: flowObservation };
    expect(appleMailboxFlowEvidenceRows(evidence)[1]?.status).toBe('尚未观察');
    expect(iframeFlowRows(evidence)).toEqual(appleMailboxFlowEvidenceRows(evidence));
  });
  it('异常200明确停止，同时保留原首次失败判断', () => {
    const evidence = {
      version: 1,
      signup: {
        ...flowObservation,
        pageKind: 'unknown',
        decision: 'rejected',
        reason: 'unexpected_page'
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows[1]?.status).toBe('已停止，等待核对');
    expect(rows[1]?.detail).toContain('响应状态 200');
    expect(rows[1]?.detail).toContain('页面类型与预期不符');
    expect(rows[2]?.status).toBe('尚未观察');
    expect(
      appleMailboxDiagnostic({
        stage: 'sentinel',
        firstFailure: {
          stage: 'sentinel',
          errorKind: 'unknown',
          httpStatus: 200,
          elapsedMs: 1,
          observedAt: flowObservation.observedAt
        }
      })
    ).toContain('首次失败：注册前置校验');
    expect(
      appleMailboxDiagnostic({
        firstFailure: {
          stage: 'signup',
          errorKind: 'http_rejected',
          httpStatus: 200,
          elapsedMs: 10,
          observedAt: flowObservation.observedAt
        }
      })
    ).toContain('首次失败：提交注册表单');
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it('新版错误响应与页面分类独立展示，不把已识别页面误写为未知', () => {
    const evidence = {
      version: 2,
      signup: {
        ...flowObservation,
        decision: 'rejected',
        reason: 'upstream_error',
        responseDetails: {
          ...flowResponseDetails,
          errorSignal: 'error',
          errorShape: 'object',
          errorKind: 'account_creation_failed'
        }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows[1]?.status).toBe('已停止，等待核对');
    expect(rows[1]?.detail).toContain('官网响应携带错误');
    expect(rows[1]?.detail).toContain('响应错误：携带单项错误');
    expect(rows[1]?.detail).toContain('单项错误结构：对象');
    expect(rows[1]?.detail).toContain('错误集合结构：未提供');
    expect(rows[1]?.detail).toContain('上游错误分类：拒绝创建账号');
    expect(rows[1]?.detail).toContain('页面类型：新账号注册');
    expect(rows[1]?.detail).toContain('页面结构：类型已识别');
    expect(rows[1]?.detail).not.toContain('未知页面');
    expect(rows[1]?.detail).not.toContain('account_creation_failed');
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it.each([
    ['missing', '页面结构异常：未提供页面信息'],
    ['non_object', '页面结构异常：页面信息不是对象'],
    ['type_missing', '页面结构异常：缺少页面类型'],
    ['type_non_string', '页面结构异常：页面类型不是文本'],
    ['type_known', '页面结构：类型已识别'],
    ['type_unknown', '未知页面：类型尚未识别']
  ])('新版页面结构%s明确区分结构异常和未知页面', (pageShape, expected) => {
    const evidence = {
      version: 2,
      signup: {
        ...flowObservation,
        pageKind: pageShape === 'type_known' ? 'new_account' : 'unknown',
        responseDetails: { ...flowResponseDetails, pageShape }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows[1]?.detail).toContain(expected);
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it.each([
    ['none', 'none', '响应错误：未携带错误', '上游错误分类：无'],
    ['error', 'user_exists', '响应错误：携带单项错误', '上游错误分类：账号已存在'],
    ['errors', 'other', '响应错误：携带错误集合', '上游错误分类：其他'],
    ['both', 'other', '响应错误：同时携带两类错误', '上游错误分类：其他']
  ])('新版错误摘要%s始终使用封闭中文标签', (errorSignal, errorKind, signal, kind) => {
    const evidence = {
      version: 2,
      signup: {
        ...flowObservation,
        responseDetails: { ...flowResponseDetails, errorSignal, errorKind }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows[1]?.detail).toContain(signal);
    expect(rows[1]?.detail).toContain(kind);
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it('旧版展示保持原样，新版非对象响应缺少摘要时不推断错误或页面结构', () => {
    const v1 = { version: 1, signup: flowObservation };
    const v2 = { version: 2, signup: flowObservation };
    const oldRows = appleMailboxFlowEvidenceRows(v1);
    expect(
      appleMailboxFlowEvidenceRows({
        version: 1,
        signup: { ...flowObservation, responseDetails: flowResponseDetails }
      })
    ).toEqual(oldRows);
    expect(appleMailboxFlowEvidenceRows(v2)).toEqual(oldRows);
    expect(iframeFlowRows(v1)).toEqual(oldRows);
    expect(iframeFlowRows(v2)).toEqual(oldRows);
    const unrelated = {
      version: 2,
      authorize: { ...flowObservation, responseDetails: flowResponseDetails },
      password: { ...flowObservation, responseDetails: flowResponseDetails }
    };
    expect(JSON.stringify(appleMailboxFlowEvidenceRows(unrelated))).not.toContain('响应错误');
    expect(iframeFlowRows(unrelated)).toEqual(appleMailboxFlowEvidenceRows(unrelated));
  });
  it('新版摘要的未知字段、恶意枚举与非对象资料均不泄漏正文', () => {
    const sensitive = 'https://synthetic-secret.invalid/?token=synthetic-token';
    const evidence = {
      version: 2,
      signup: {
        ...flowObservation,
        responseDetails: {
          errorSignal: sensitive,
          errorShape: sensitive,
          errorsShape: sensitive,
          errorKind: sensitive,
          pageShape: sensitive,
          message: sensitive,
          body: sensitive
        }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    const displayed = JSON.stringify(rows);
    for (const secret of [sensitive, 'synthetic-token', 'synthetic-secret.invalid'])
      expect(displayed).not.toContain(secret);
    expect(rows[1]?.detail).toContain('响应错误：待核对');
    expect(rows[1]?.detail).toContain('页面结构：待核对');
    expect(iframeFlowRows(evidence)).toEqual(rows);
    for (const responseDetails of [null, sensitive, [sensitive], 12, true]) {
      const malformed = {
        version: 2,
        signup: { ...flowObservation, responseDetails }
      };
      expect(appleMailboxFlowEvidenceRows(malformed)).toEqual(
        appleMailboxFlowEvidenceRows({ version: 2, signup: flowObservation })
      );
      expect(iframeFlowRows(malformed)).toEqual(appleMailboxFlowEvidenceRows(malformed));
    }
  });
  it('不显示响应正文、原始网址、请求标识、凭据或未知枚举，即使传入受污染资料', () => {
    const sensitive =
      'https://synthetic-user:synthetic-password@example.invalid/path?token=synthetic-secret';
    const evidence = {
      version: 1,
      signup: {
        ...flowObservation,
        contentType: sensitive,
        pageKind: sensitive,
        reason: sensitive,
        decision: sensitive,
        redirectHosts: [sensitive, {}, 'other'],
        httpStatus: sensitive,
        officialOrigin: sensitive,
        observedAt: sensitive,
        requestIdSha256: sensitive,
        payload: sensitive,
        rawUrl: sensitive
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    const displayed = JSON.stringify(rows);
    for (const secret of [sensitive, 'synthetic-password', 'synthetic-secret', 'example.invalid'])
      expect(displayed).not.toContain(secret);
    expect(displayed).toContain('待核对');
    expect(iframeFlowRows(evidence)).toEqual(rows);
  });
  it('API和Admin证据类型逐字同型且仅登记在任务，不写入邮箱及同步资料', () => {
    const api = readFileSync(
      new URL(
        '../../../../../../apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
        import.meta.url
      ),
      'utf8'
    );
    const admin = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8');
    const block = (source: string) =>
      source.slice(
        source.indexOf('export interface AppleMailboxFlowResponseDetails'),
        source.indexOf('export interface AppleMailboxTask {')
      );
    expect(block(api)).toBe(block(admin));
    for (const source of [api, admin]) {
      expect(source.match(/flowEvidence\?:/g)).toHaveLength(1);
      expect(source).toContain(
        'export interface AppleMailboxTask {\n  flowEvidence?: AppleMailboxFlowEvidence;'
      );
    }
  });
  it('第三版增加前置校验并说明必须验证，即使已取得凭据也不表示可以继续', () => {
    const evidence = {
      version: 3,
      sentinel: {
        ...flowObservation,
        pageKind: 'not_checked',
        decision: 'rejected',
        reason: 'challenge_required',
        sentinelDetails: {
          tokenPresent: true,
          proofOfWorkRequired: 'required',
          turnstileRequired: 'required'
        }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows.map((row) => row.title)).toEqual([
      '授权入口',
      '注册前置校验',
      '提交注册邮箱',
      '提交注册密码'
    ]);
    expect(rows[1]?.status).toBe('已停止，等待核对');
    expect(rows[1]?.detail).toContain('官网要求额外验证，当前流程已停止');
    expect(rows[1]?.detail).toContain('官网验证凭据：已取得');
    expect(rows[1]?.detail).toContain('额外计算验证：官网要求');
    expect(rows[1]?.detail).toContain('交互验证：官网要求');
    expect(rows[2]?.status).toBe('尚未观察');
    expect(iframeFlowRows(evidence)).toEqual(rows);
    for (const version of [1, 2]) {
      const legacy = { ...evidence, version };
      expect(appleMailboxFlowEvidenceRows(legacy)).toEqual(
        appleMailboxFlowEvidenceRows({ version })
      );
      expect(iframeFlowRows(legacy)).toEqual(appleMailboxFlowEvidenceRows(legacy));
    }
  });
  it.each([
    [
      'missing_token',
      false,
      'not_required',
      'missing',
      '未取得官网验证凭据',
      '官网验证凭据：未取得'
    ],
    [
      'challenge_invalid',
      true,
      'invalid',
      'missing',
      '官网验证要求无法确认',
      '额外计算验证：要求格式无效'
    ]
  ])(
    '第三版前置校验%s映射为明确中文原因',
    (reason, tokenPresent, proofOfWorkRequired, turnstileRequired, expected, detail) => {
      const evidence = {
        version: 3,
        sentinel: {
          ...flowObservation,
          decision: 'rejected',
          reason,
          sentinelDetails: { tokenPresent, proofOfWorkRequired, turnstileRequired }
        }
      };
      const rows = appleMailboxFlowEvidenceRows(evidence);
      expect(rows[1]?.detail).toContain(expected);
      expect(rows[1]?.detail).toContain(detail);
      expect(rows[1]?.detail).toContain('交互验证：官网未说明');
      expect(iframeFlowRows(evidence)).toEqual(rows);
    }
  );
  it('第三版密码200的错误和来源问题明确展示，不因缺少页面信息误报结构异常', () => {
    const evidence = {
      version: 3,
      password: {
        ...flowObservation,
        pageKind: 'missing',
        decision: 'rejected',
        reason: 'upstream_error',
        responseDetails: {
          ...flowResponseDetails,
          errorSignal: 'error',
          errorShape: 'object',
          errorKind: 'account_creation_failed',
          pageShape: 'missing',
          pageTypeSha256: null
        }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    expect(rows[3]?.status).toBe('已停止，等待核对');
    expect(rows[3]?.detail).toContain('官网响应携带错误');
    expect(rows[3]?.detail).toContain('上游错误分类：拒绝创建账号');
    expect(rows[3]?.detail).toContain('此阶段未要求页面类型');
    expect(rows[3]?.detail).not.toContain('页面结构异常');
    expect(iframeFlowRows(evidence)).toEqual(rows);
    const originFailure = {
      version: 3,
      password: { ...evidence.password, officialOrigin: false, reason: 'untrusted_origin' }
    };
    expect(appleMailboxFlowEvidenceRows(originFailure)[3]?.detail).toContain('来源未通过校验');
    expect(iframeFlowRows(originFailure)).toEqual(appleMailboxFlowEvidenceRows(originFailure));
  });
  it('第三版未知页面只显示摘要存在性，受污染字段和挑战字段不泄漏正文', () => {
    const secret = 'https://fixture.invalid/?token=private-fixture';
    const digest = 'b'.repeat(64);
    const evidence = {
      version: 3,
      signup: {
        ...flowObservation,
        pageKind: 'unknown',
        decision: 'rejected',
        reason: 'unexpected_page',
        responseDetails: {
          ...flowResponseDetails,
          pageShape: 'type_unknown',
          pageTypeSha256: digest
        }
      },
      sentinel: {
        ...flowObservation,
        decision: 'rejected',
        reason: secret,
        sentinelDetails: {
          tokenPresent: secret,
          proofOfWorkRequired: secret,
          turnstileRequired: secret,
          token: secret
        }
      }
    };
    const rows = appleMailboxFlowEvidenceRows(evidence);
    const shown = JSON.stringify(rows);
    expect(rows[2]?.detail).toContain('未知页面标识摘要已记录');
    expect(rows[1]?.detail).toContain('官网验证凭据：待核对');
    expect(rows[1]?.detail).toContain('额外计算验证：待核对');
    expect(rows[1]?.detail).toContain('交互验证：待核对');
    for (const value of [secret, 'private-fixture', 'fixture.invalid', digest])
      expect(shown).not.toContain(value);
    expect(iframeFlowRows(evidence)).toEqual(rows);
    const malformedDigest = {
      version: 3,
      signup: {
        ...evidence.signup,
        responseDetails: { ...evidence.signup.responseDetails, pageTypeSha256: secret }
      }
    };
    expect(appleMailboxFlowEvidenceRows(malformedDigest)[2]?.detail).toContain(
      '未知页面标识摘要未记录'
    );
    expect(JSON.stringify(appleMailboxFlowEvidenceRows(malformedDigest))).not.toContain(secret);
    expect(iframeFlowRows(malformedDigest)).toEqual(appleMailboxFlowEvidenceRows(malformedDigest));
  });
});
