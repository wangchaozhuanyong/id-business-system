import { describe, expect, it } from 'vitest';
import { unpaidValidationEntries } from './unpaid-validation-labels';
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
    ['PROXY_CONNECTION_FAILED', '代理连通性检查连续5次失败']
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
