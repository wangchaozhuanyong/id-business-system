import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isAutoRegistrationPage } from './bridge';
import {
  appleMailboxPage,
  type AppleMailboxRow,
  type AppleMailboxFlowObservation
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
    for (const value of [undefined, null, {}, { version: 2 }, []]) {
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
        source.indexOf('export interface AppleMailboxFlowObservation'),
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
});
