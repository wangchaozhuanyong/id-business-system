import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { onlineBillingActionResult } from './billing-presentation';
import OnlineResultDialog from './OnlineResultDialog.vue';

vi.mock('@/v2/components/V2ConfirmDialog.vue', () => ({
  default: { template: '<section><slot /></section>' }
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('./useOnlineTask', () => ({
  useOnlineTask: () => ({ connected: { value: false }, error: { value: '' }, refresh: vi.fn() })
}));

describe('账单消费汇总结果弹层', () => {
  it('没有成功账单时显示明确空状态', async () => {
    const html = await renderToString(
      createSSRApp(OnlineResultDialog, {
        modelValue: true,
        result: onlineBillingActionResult([])
      })
    );
    expect(html).toContain('当前没有已确认成功的账单');
  });
  it('实际组件展示数组汇总、未知笔数和完整性，不再出现空结果', async () => {
    const result = onlineBillingActionResult([
      {
        cardLast4: '0001',
        currency: 'USD',
        amount: null,
        knownAmount: '20.1234',
        count: 2,
        knownAmountCount: 1,
        unknownAmountCount: 1,
        isComplete: false
      }
    ]);
    const html = await renderToString(
      createSSRApp(OnlineResultDialog, { modelValue: true, result })
    );
    expect(html).toContain('卡片消费汇总');
    expect(html).toContain('已知金额小计：20.1234');
    expect(html).toContain('金额待核对笔数：1');
    expect(html).toContain('金额是否完整：否');
    expect(html).toContain('币种：USD');
  });
  it('普通详情响应保留原结构，失败金额说明可见', async () => {
    const original = { amount: '20.1234', amountMeaning: '结账应付金额，未确认扣款' };
    expect(onlineBillingActionResult(original)).toBe(original);
    const html = await renderToString(
      createSSRApp(OnlineResultDialog, {
        modelValue: true,
        result: original
      })
    );
    expect(html).toContain('金额说明');
    expect(html).toContain('未确认扣款');
  });
});
