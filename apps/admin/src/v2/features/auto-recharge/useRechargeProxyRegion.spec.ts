import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useRechargeProxyRegion } from './useRechargeProxyRegion';
import type { RechargeProxyItem } from './recharge-proxy-api';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';

const proxy = (
  id: string,
  countryCode: string,
  kind: RechargeProxyItem['kind'] = 'mobile',
  status: RechargeProxyItem['status'] = 'active'
): RechargeProxyItem => ({
  id,
  countryCode,
  kind,
  status,
  connectionMode: 'extraction',
  protocol: 'http',
  linkMask: '合成代理',
  remark1: null,
  remark2: null,
  createdAt: '',
  updatedAt: ''
});
function setup(
  initial: {
    country?: string;
    currency?: string;
    proxyId?: string;
    manual?: boolean;
    defaultCountry?: string;
  } = {}
) {
  const scope = effectScope();
  const context = {
    plan: ref('plus'),
    paymentMode: ref(true),
    currency: ref(initial.currency ?? 'PHP'),
    country: ref(initial.country ?? ''),
    proxyId: ref(initial.proxyId ?? ''),
    defaultCountry: ref(initial.defaultCountry ?? 'PH'),
    manualSelection: ref(initial.manual ?? false),
    locked: ref(false),
    currencies: ref(
      ['PHP', 'USD', 'MYR', 'EUR', 'GBP', 'CLP'].map((value) => ({ value, label: value }))
    ),
    countries: ref(['US', 'PH', 'MY', 'DE', 'FR', 'GB']),
    query: {
      data: ref({
        items: [
          proxy('ph-home', 'PH', 'dynamic_residential'),
          proxy('ph-mobile', 'PH'),
          proxy('us-mobile', 'US'),
          proxy('my-mobile', 'MY'),
          proxy('fr-mobile', 'FR')
        ],
        total: 5
      }),
      phase: ref<V2QueryPhase>('ready'),
      error: ref<unknown>(null),
      isParameterTransition: ref(false),
      ensureFresh: vi.fn().mockResolvedValue(undefined)
    }
  };
  const region = scope.run(() => useRechargeProxyRegion(context))!;
  return { scope, context, region };
}
describe('充值币种、国家与代理联动', () => {
  it.each(['pro-5x', 'pro-500'])(
    '%s 自动使用智利币种、国家和同国代理，切回 Plus 恢复默认国家',
    (plan) => {
      const { scope, context, region } = setup();
      context.query.data.value.items.push(proxy('cl-mobile', 'CL'));
      context.plan.value = plan;
      expect(region.planRegionLocked.value).toBe(true);
      expect(context.country.value).toBe('CL');
      expect(context.currency.value).toBe('CLP');
      expect(context.proxyId.value).toBe('cl-mobile');
      context.defaultCountry.value = 'MY';
      expect(context.country.value).toBe('CL');
      context.plan.value = 'plus';
      expect(region.planRegionLocked.value).toBe(false);
      expect(context.country.value).toBe('MY');
      expect(context.currency.value).toBe('MYR');
      scope.stop();
    }
  );
  it('智利代理缺失时不退回其他国家，币种未启用时明确阻塞', () => {
    const { scope, context, region } = setup();
    context.plan.value = 'pro-500';
    expect(context.country.value).toBe('CL');
    expect(context.currency.value).toBe('CLP');
    expect(context.proxyId.value).toBe('');
    expect(region.note.value).toContain('暂无启用代理');
    context.currencies.value = context.currencies.value.filter((item) => item.value !== 'CLP');
    expect(region.countryCurrencyError.value).toContain('尚未启用');
    scope.stop();
  });
  it('仅登录模式不应用充值套餐地区，执行中不切换代理', () => {
    const { scope, context, region } = setup();
    context.locked.value = true;
    context.plan.value = 'pro-500';
    expect(context.country.value).toBe('PH');
    context.paymentMode.value = false;
    context.locked.value = false;
    expect(region.planRegionLocked.value).toBe(false);
    expect(context.country.value).toBe('PH');
    scope.stop();
  });
  it('首次默认菲律宾和比索，优先移动代理，默认国家排在首位', () => {
    const { scope, context, region } = setup();
    expect(context.country.value).toBe('PH');
    expect(context.currency.value).toBe('PHP');
    expect(context.proxyId.value).toBe('ph-mobile');
    expect(region.countries.value[0]).toBe('PH');
    expect(region.defaultCountries.value[0]).toBe('PH');
    scope.stop();
  });
  it('币种到国家、国家到币种双向联动，没有循环刷新', () => {
    const { scope, context } = setup();
    context.currency.value = 'USD';
    expect(context.country.value).toBe('US');
    expect(context.proxyId.value).toBe('us-mobile');
    context.country.value = 'MY';
    expect(context.currency.value).toBe('MYR');
    expect(context.proxyId.value).toBe('my-mobile');
    expect(context.query.ensureFresh).toHaveBeenCalledTimes(2);
    scope.stop();
  });
  it('更改默认国家立即匹配币种和移动代理，保留欧元已选国家', () => {
    const { scope, context } = setup();
    context.defaultCountry.value = 'FR';
    expect(context.country.value).toBe('FR');
    expect(context.currency.value).toBe('EUR');
    expect(context.proxyId.value).toBe('fr-mobile');
    context.currency.value = 'USD';
    context.currency.value = 'EUR';
    expect(context.country.value).toBe('FR');
    context.country.value = 'DE';
    expect(context.currency.value).toBe('EUR');
    expect(context.country.value).toBe('DE');
    scope.stop();
  });
  it('迟到的旧国家数据与参数过渡不能被自动选入', () => {
    const { scope, context } = setup();
    context.query.isParameterTransition.value = true;
    context.country.value = 'US';
    expect(context.proxyId.value).toBe('');
    context.query.data.value = { items: [proxy('late-ph', 'PH')], total: 1 };
    context.query.isParameterTransition.value = false;
    expect(context.proxyId.value).toBe('');
    context.query.data.value = { items: [proxy('current-us', 'US')], total: 1 };
    expect(context.proxyId.value).toBe('current-us');
    scope.stop();
  });
  it('没有移动代理时选择同国其他启用代理，没有任何代理时明确提示', () => {
    const { scope, context, region } = setup();
    context.query.data.value = {
      items: [
        proxy('disabled-mobile', 'PH', 'mobile', 'disabled'),
        proxy('ph-home', 'PH', 'dynamic_residential'),
        proxy('other-country', 'US')
      ],
      total: 3
    };
    expect(context.proxyId.value).toBe('ph-home');
    expect(region.note.value).toContain('暂无启用的移动代理');
    context.query.data.value = { items: [], total: 0 };
    expect(context.proxyId.value).toBe('');
    expect(region.note.value).toContain('暂无启用代理');
    scope.stop();
  });
  it('手动选择在刷新和恢复时保留，自动选择在出现移动代理后改用移动代理', () => {
    const manual = setup({ country: 'PH', proxyId: 'ph-home', manual: true });
    expect(manual.context.proxyId.value).toBe('ph-home');
    manual.context.query.data.value = { ...manual.context.query.data.value };
    expect(manual.context.proxyId.value).toBe('ph-home');
    manual.scope.stop();
    const auto = setup();
    auto.context.query.data.value = {
      items: [proxy('ph-home', 'PH', 'static_residential')],
      total: 1
    };
    expect(auto.context.proxyId.value).toBe('ph-home');
    auto.context.query.data.value = {
      items: [proxy('ph-home', 'PH', 'static_residential'), proxy('ph-new-mobile', 'PH')],
      total: 2
    };
    expect(auto.context.proxyId.value).toBe('ph-new-mobile');
    auto.scope.stop();
  });
  it('执行期间和读取失败时不自动换代理，解锁后再匹配', () => {
    const { scope, context } = setup();
    context.locked.value = true;
    context.query.data.value = { items: [proxy('ph-new', 'PH')], total: 1 };
    expect(context.proxyId.value).toBe('ph-mobile');
    context.query.phase.value = 'refresh-error';
    context.locked.value = false;
    expect(context.proxyId.value).toBe('ph-mobile');
    context.query.phase.value = 'ready';
    expect(context.proxyId.value).toBe('ph-new');
    scope.stop();
  });
  it('不支持或未启用的币种明确阻塞，不任意回退到其他国家', async () => {
    const { scope, context, region } = setup();
    context.country.value = 'JP';
    expect(context.currency.value).toBe('PHP');
    expect(region.countryCurrencyError.value).toContain('尚未启用');
    context.currencies.value.push({ value: 'JPY', label: '日元' });
    await nextTick();
    expect(context.currency.value).toBe('JPY');
    expect(region.countryCurrencyError.value).toBe('');
    context.currency.value = 'USDT';
    expect(context.country.value).toBe('');
    expect(context.proxyId.value).toBe('');
    expect(region.countryCurrencyError.value).toContain('暂无对应关系');
    scope.stop();
  });
});
