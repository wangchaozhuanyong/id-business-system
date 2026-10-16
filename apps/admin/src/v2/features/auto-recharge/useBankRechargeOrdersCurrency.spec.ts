import { effectScope, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';

const mocks = vi.hoisted(() => ({ createCard: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({}) }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { id: 'operator', roles: ['admin'] } })
}));
vi.mock('@/v2/features/online-recharge/public-api', () => ({ canManageOnlineOrders: () => true }));
vi.mock('./bank-recharge-api', () => ({ bankRechargeApi: { createCard: mocks.createCard } }));
vi.mock('./useBitOrderPricing', () => ({ useBitOrderPricing: () => ({}) }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: { success: vi.fn() } }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: JSON.stringify,
  useV2ModuleQuery: (options: { key: string }) => ({
    data: ref(
      options.key === 'bank-recharge-card-options'
        ? {
            items: [
              { id: 'usd-card', currencyCode: 'USD', active: true },
              { id: 'php-card', currencyCode: 'PHP', active: true },
              { id: 'disabled-card', currencyCode: 'PHP', active: false }
            ]
          }
        : undefined
    ),
    phase: ref('ready'),
    refresh: vi.fn(),
    ensureFresh: vi.fn()
  })
}));

let stop: () => void;
function create() {
  const scope = effectScope();
  stop = () => scope.stop();
  return scope.run(() => useBankRechargeOrdersPage())!;
}
beforeEach(() => {
  clearV2SessionDrafts();
  vi.clearAllMocks();
});
afterEach(() => stop?.());

describe('充值订单银行卡不锁定币种', () => {
  it('不同登记币种的启用卡都可选择，停用卡仍被排除', async () => {
    const page = create();
    page.form.chargeCurrencyCode = 'PHP';
    expect(page.availableCards.value.map((card) => card.id)).toEqual(['usd-card', 'php-card']);
    page.form.cardId = 'usd-card';
    page.form.chargeCurrencyCode = 'SGD';
    await nextTick();
    expect(page.availableCards.value.map((card) => card.id)).toEqual(['usd-card', 'php-card']);
    expect(page.form.cardId).toBe('usd-card');
  });
  it('快捷新增无需卡片币种，成功后自动选中新标识', async () => {
    const page = create();
    page.form.chargeCurrencyCode = 'PHP';
    page.cardForm.label = '通用卡';
    page.cardForm.last4 = '1111';
    mocks.createCard.mockResolvedValue({ id: 'new-card', currencyCode: 'PHP' });
    await page.saveCard();
    expect(mocks.createCard).toHaveBeenCalledWith({
      label: '通用卡',
      last4: '1111',
      currencyCode: 'PHP'
    });
    expect(page.form.cardId).toBe('new-card');
  });
});
