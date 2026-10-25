import { describe, expect, it } from 'vitest';
import { unpaidValidationEntries } from './unpaid-validation-labels';
describe('国家交互与附件上传的具体停点', () => {
  it('区分控件本身和内嵌外框的视口结果，不展示内部字段或原始资料', () => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'failed_with_class',
      lastStage: 'billing_fill',
      failureClass: 'BILLING_FILL_FAILED',
      failureCode: 'CHECKOUT_CONTROL_BLOCKED',
      formDiagnostics: {
        steps: [
          {
            field: 'country',
            phase: 'precheck',
            state: 'failed',
            tag: 'select',
            frameKind: 'embedded'
          }
        ],
        inspection: {
          interactionChecks: [
            {
              field: 'country',
              initialReason: 'outside_viewport',
              afterScrollReason: 'outside_viewport',
              scroll: { state: 'completed', durationMs: 40 },
              pointChecks: [
                { scope: 'control', depth: 0, reason: 'none' },
                {
                  scope: 'frame_owner',
                  depth: 1,
                  reason: 'outside_viewport',
                  geometry: {
                    left: 10,
                    top: 900,
                    width: 400,
                    height: 200,
                    viewportWidth: 1280,
                    viewportHeight: 720
                  }
                }
              ],
              value: 'SYNTHETIC_PRIVATE'
            }
          ]
        }
      },
      evidenceUploads: [
        {
          kind: 'diagnostic',
          outcome: 'failed',
          reason: 'http_error',
          httpStatus: 500,
          durationMs: 50
        },
        { kind: 'batch', outcome: 'skipped', reason: 'deadline_exhausted', remainingFiles: 20 }
      ]
    });
    expect(rows.find((row) => row.label === '控件停止位置')?.value).toBe(
      '国家／交互前检查／原生下拉框／内嵌页面'
    );
    expect(rows.find((row) => row.label === '滚动结果')?.value).toBe('已完成／40 毫秒');
    expect(rows.find((row) => row.label === '位置观测 1')?.value).toContain(
      '控件本身：位置检查通过'
    );
    expect(rows.find((row) => row.label === '位置观测 2')?.value).toContain(
      '第 1 层内嵌页面外框：视口之外'
    );
    expect(rows.find((row) => row.label === '附件上传异常 1')?.value).toContain('HTTP 500');
    expect(rows.find((row) => row.label === '附件上传异常 2')?.value).toContain('剩余 20 个文件');
    expect(JSON.stringify(rows)).not.toMatch(
      /outside_viewport|precheck|http_error|SYNTHETIC_PRIVATE/
    );
  });
  it('未允许的异常原因只展示未确认，不原样显示', () => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      evidenceUploads: [{ kind: 'diagnostic', outcome: 'failed', reason: 'SYNTHETIC_PRIVATE' }]
    });
    expect(rows.at(-1)?.value).toContain('原因未确认');
    expect(JSON.stringify(rows)).not.toContain('SYNTHETIC_PRIVATE');
  });
});
describe('不付款验收回显', () => {
  it('已就绪与真实充值成功分开，内部枚举不直接展示', () => {
    const entries = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'ready_before_payment',
      failureClass: 'NONE',
      lastStage: 'button_ready',
      cardVerified: true,
      billingVerified: true,
      buttonReady: true,
      timeline: [
        {
          stage: 'card_fill',
          startedAt: '2026-10-24T01:00:00.000Z',
          endedAt: '2026-10-24T01:00:01.000Z'
        }
      ]
    });
    expect(entries[0]?.value).toBe('付款前就绪，未提交');
    expect(JSON.stringify(entries)).not.toMatch(/ready_before_payment|button_ready|NONE|card_fill/);
    expect(entries.at(-1)?.value).toContain('1000 毫秒');
  });
  it('普通403保留状态，不声称政策或地区根因', () => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'failed_with_class',
      failureClass: 'CHECKOUT_REJECTED',
      httpStatus: 403
    });
    expect(rows.at(-1)?.value).toBe('HTTP 403');
    expect(JSON.stringify(rows)).not.toMatch(/政策|地区限制/);
  });
});

describe('代理与专用浏览器的具体停止原因', () => {
  it.each([
    ['PROFILE_EXIT_CHANGED', '代理出口与浏览器会话绑定不一致'],
    ['PROFILE_LAUNCH_FAILED', '专用浏览器启动未完成'],
    ['PROFILE_BUSY', '同一账号与代理的浏览器正在使用'],
    ['PROFILE_PROXY_INVALID', '代理绑定格式无效'],
    ['PROFILE_CLEANUP_FAILED', '浏览器关闭未确认'],
    ['PROFILE_IDENTITY_MISSING', '缺少账号及用户标识'],
    ['PROFILE_BINDING_INVALID', '浏览器出口绑定记录无效'],
    ['PROFILE_DIRECTORY_INVALID', '浏览器会话目录无效'],
    ['PROXY_CONNECTION_FAILED', '代理连通性检测已用尽5次']
  ])('%s 显示中文原因', (failureCode, text) => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      outcome: 'failed_with_class',
      lastStage: 'proxy',
      failureClass: 'BROWSER_PROFILE_UNAVAILABLE',
      failureCode
    });
    expect(rows.find((row) => row.label === '停止分类')?.value).toContain(text);
    expect(JSON.stringify(rows)).not.toContain(failureCode);
  });
  it('未知错误不显示原始错误字符串', () => {
    const rows = unpaidValidationEntries({
      format: 'unpaid-validation-v1',
      failureClass: 'OTHER',
      failureCode: 'PROFILE_PRIVATE_ARBITRARY'
    });
    expect(rows.find((row) => row.label === '停止分类')?.value).toBe('其他执行异常，详见诊断');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_ARBITRARY');
  });
});
