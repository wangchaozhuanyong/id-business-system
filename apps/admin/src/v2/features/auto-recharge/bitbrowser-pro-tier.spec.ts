import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeProTierQuoteState, prepareDirectProTier } from './bitbrowser-pro-tier';
import { verifyDirectCheckoutQuote } from './bitbrowser-stripe-quote';
import { DirectBrowserError } from './bitbrowser-direct-api';

const checkoutId = 'oaics_synthetic_pro_tier';
const entity = 'openai_llc';
const currentText =
  'Total due today PHP 9990.00\nVAT (12%) PHP 1070.36\nRenews PHP 9990.00 / month';
const staleText = 'Total due today PHP 6490.00\nVAT (12%) PHP 695.36\nRenews PHP 6490.00 / month';
const document = () => ({
  checkout_session_id: checkoutId,
  processor_entity: entity,
  plan_name: 'chatgptpro',
  status: 'open',
  payment_status: 'unpaid',
  checkout_state: {
    id: checkoutId,
    currency: 'php',
    total: { total: { minorUnitsAmount: 999000 } },
    taxAmounts: [{ minorUnitsAmount: 107036 }]
  }
});
let now = 0;
beforeEach(() => {
  now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let text = staleText;
  let selected = false;
  const actions: string[] = [];
  const input = {
    plan: 'pro-20x' as const,
    checkoutId,
    entity,
    currency: 'PHP',
    deadline: 120_000,
    inspect: vi.fn(async (action: 'tier' | 'verify_tier' | 'inspect') => {
      actions.push(action);
      if (action === 'inspect') return { kind: 'page', checkoutId, entity, text };
      if (action === 'tier') {
        selected = true;
        return { kind: 'tier_changed' };
      }
      return { kind: selected ? 'tier_ready' : 'tier_unverified' };
    }),
    read: vi.fn(async () => document()),
    reload: vi.fn(async () => {
      text = currentText;
    }),
    pause: vi.fn(async () => {
      now += 200;
    }),
    remaining: vi.fn()
  };
  return {
    input,
    actions,
    setText: (value: string) => {
      text = value;
    }
  };
}

describe('Pro 原单切档与页面金额同步', () => {
  it('接口、当前档位与页面一致时继续，准备检查不返回最终账单报价', async () => {
    const f = fixture();
    f.setText(currentText);
    await expect(prepareDirectProTier(f.input)).resolves.toBeUndefined();
    expect(f.input.reload).not.toHaveBeenCalled();
    expect(f.actions.filter((action) => action === 'tier')).toHaveLength(1);
  });
  it('接口已切档但页面是旧价，等待后只刷新原订单一次，再核对同一档位', async () => {
    const f = fixture();
    await prepareDirectProTier(f.input);
    expect(now).toBeGreaterThanOrEqual(2_000);
    expect(f.input.reload).toHaveBeenCalledOnce();
    expect(f.actions.filter((action) => action === 'tier')).toHaveLength(1);
    expect(f.actions.at(-1)).toBe('verify_tier');
  });
  it('延迟的旧套餐回执只等待，不刷新或重复选择', async () => {
    const f = fixture();
    f.setText(currentText);
    f.input.read.mockResolvedValueOnce({ ...document(), plan_name: 'chatgptprolite' });
    await prepareDirectProTier(f.input);
    expect(f.input.read).toHaveBeenCalledTimes(2);
    expect(f.input.reload).not.toHaveBeenCalled();
    expect(f.actions.filter((action) => action === 'tier')).toHaveLength(1);
  });
  it('原单刷新期间的临时执行上下文错误只等待，不再切档或刷新', async () => {
    const f = fixture();
    const inspect = f.input.inspect.getMockImplementation()!;
    let interrupted = false;
    f.input.inspect.mockImplementation(async (action) => {
      if (f.input.reload.mock.calls.length && !interrupted) {
        interrupted = true;
        throw new DirectBrowserError('bitbrowser_direct_command_failed');
      }
      return inspect(action);
    });
    await expect(prepareDirectProTier(f.input)).resolves.toBeUndefined();
    expect(interrupted).toBe(true);
    expect(f.input.reload).toHaveBeenCalledOnce();
    expect(f.actions.filter((action) => action === 'tier')).toHaveLength(1);
  });
  it.each(['bitbrowser_direct_cancelled', 'bitbrowser_direct_debug_unavailable'] as const)(
    '原单刷新后的%s仍立即停止',
    async (reason) => {
      const f = fixture();
      const inspect = f.input.inspect.getMockImplementation()!;
      f.input.inspect.mockImplementation(async (action) => {
        if (f.input.reload.mock.calls.length) throw new DirectBrowserError(reason);
        return inspect(action);
      });
      await expect(prepareDirectProTier(f.input)).rejects.toMatchObject({ reason });
      expect(f.input.reload).toHaveBeenCalledOnce();
      expect(now).toBeLessThan(3_000);
    }
  );
  it('刷新前的控制失败不当作导航加载吞掉', async () => {
    const f = fixture();
    f.input.inspect.mockRejectedValue(new DirectBrowserError('bitbrowser_direct_command_failed'));
    await expect(prepareDirectProTier(f.input)).rejects.toMatchObject({
      reason: 'bitbrowser_direct_command_failed'
    });
    expect(f.input.reload).not.toHaveBeenCalled();
    expect(f.input.pause).not.toHaveBeenCalled();
  });
  it('刷新后仍是旧价则终止，不建单、不重复切档或刷新', async () => {
    const f = fixture();
    f.input.reload.mockResolvedValue(undefined);
    await expect(prepareDirectProTier(f.input)).rejects.toThrow('官网页面与结算接口金额不一致。');
    expect(f.input.reload).toHaveBeenCalledOnce();
    expect(f.actions.filter((action) => action === 'tier')).toHaveLength(1);
    expect(now).toBeLessThan(21_000);
  });
  it.each([
    { checkout_session_id: 'oaics_other' },
    { processor_entity: 'other' },
    { status: 'complete' },
    { payment_status: 'paid' },
    { checkout_state: { ...document().checkout_state, id: 'oaics_other' } },
    { checkout_state: { ...document().checkout_state, currency: 'usd' } }
  ])('原单、状态或币种变化时拒绝任何恢复动作 %j', async (change) => {
    const f = fixture();
    f.input.read.mockResolvedValue({ ...document(), ...change });
    await expect(prepareDirectProTier(f.input)).rejects.toThrow();
    expect(f.input.reload).not.toHaveBeenCalled();
  });
  it('读取期间目标档位改变，不接受报价也不刷新', async () => {
    const f = fixture();
    const inspect = f.input.inspect.getMockImplementation()!;
    f.input.inspect.mockImplementation(async (action) =>
      action === 'verify_tier' && f.input.read.mock.calls.length
        ? { kind: 'tier_unverified' }
        : inspect(action)
    );
    await expect(prepareDirectProTier(f.input)).rejects.toThrow('官网套餐档位未核实。');
    expect(f.input.reload).not.toHaveBeenCalled();
  });
  it('等待期间出现付款或占用异常，立即停止且不刷新', async () => {
    const f = fixture();
    f.input.remaining.mockImplementation(() => {
      if (now >= 2_000) throw new Error('stopped');
    });
    await expect(prepareDirectProTier(f.input)).rejects.toThrow('stopped');
    expect(f.input.reload).not.toHaveBeenCalled();
  });
  it('CS 继续使用原 Stripe 报价核验，不按原生订单刷新', async () => {
    const f = fixture();
    await prepareDirectProTier({ ...f.input, checkoutId: 'cs_synthetic' });
    expect(f.input.read).not.toHaveBeenCalled();
    expect(f.input.reload).not.toHaveBeenCalled();
  });
  it('纯金额检查区分旧价与完整新价，不把缺失税额或续费当成可刷新旧价', () => {
    const check = (text: string) =>
      nativeProTierQuoteState(document(), checkoutId, entity, 'pro-20x', 'PHP', text);
    expect(check(staleText)).toBe('amount_mismatch');
    expect(check(currentText)).toBe('ready');
    expect(check('Total due today PHP 9990.00')).toBe('page_pending');
  });
  it.each(['pro-5x', 'pro-20x', 'pro-500'] as const)(
    '原生 %s 也必须再次核对当前档位',
    async (plan) => {
      await expect(
        verifyDirectCheckoutQuote(
          {},
          checkoutId,
          entity,
          plan,
          {} as never,
          currentText,
          'PHP',
          undefined,
          false
        )
      ).rejects.toThrow('official_pro_tier_unverified');
    }
  );
});
