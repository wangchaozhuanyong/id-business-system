import { effectScope, nextTick, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRechargeAddressGeneration } from './useRechargeAddressGeneration';
import type { V2RechargeAddress } from './contracts';
const mock = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('./api', () => ({ rechargeApi: { generateAddresses: mock.generate } }));
vi.mock('@/api/client', () => ({ getApiErrorMessage: (error: Error) => error.message }));
const address = { id: 'generated-address', status: 'unused' } as V2RechargeAddress;
function setup() {
  const scope = effectScope();
  const allowed = ref(true),
    automatic = ref(false),
    context = ref('first-card');
  const addresses = ref<V2RechargeAddress[]>([]);
  const select = vi.fn();
  const refresh = vi.fn(async () => {
    addresses.value = [address];
  });
  const hook = scope.run(() =>
    useRechargeAddressGeneration({
      allowed,
      automatic,
      context: () => [context.value],
      addresses,
      select,
      refresh
    })
  )!;
  return { scope, allowed, automatic, context, addresses, select, refresh, hook };
}
beforeEach(() => {
  mock.generate.mockReset().mockResolvedValue({ count: 1, items: [address] });
});
describe('比特充值地址生成', () => {
  it('一键生成后读取地址并选中，双击共用一个请求', async () => {
    const s = setup();
    const first = s.hook.generate();
    expect(s.hook.generating.value).toBe(true);
    await Promise.all([first, s.hook.generate()]);
    expect(mock.generate).toHaveBeenCalledExactlyOnceWith(1);
    expect(s.refresh).toHaveBeenCalledOnce();
    expect(s.select).toHaveBeenCalledWith(address.id);
    expect(s.hook.generating.value).toBe(false);
    s.scope.stop();
  });
  it('列表为空且资料就绪时自动生成，失败不在同一卡上自动循环重试', async () => {
    mock.generate.mockRejectedValue(new Error('生成失败'));
    const s = setup();
    s.automatic.value = true;
    await nextTick();
    await nextTick();
    expect(mock.generate).toHaveBeenCalledOnce();
    expect(s.hook.error.value).toBe('生成失败');
    s.automatic.value = false;
    await nextTick();
    s.automatic.value = true;
    await nextTick();
    expect(mock.generate).toHaveBeenCalledOnce();
    mock.generate.mockResolvedValueOnce({ count: 1, items: [address] });
    await s.hook.generate();
    expect(s.select).toHaveBeenCalledWith(address.id);
    s.scope.stop();
  });
  it('写入成功但刷新失败时重试只刷新，不重复生成', async () => {
    const s = setup();
    s.refresh.mockImplementationOnce(async () => {});
    await s.hook.generate();
    expect(s.hook.error.value).toContain('地址已生成');
    expect(s.select).not.toHaveBeenCalled();
    await s.hook.generate();
    expect(mock.generate).toHaveBeenCalledOnce();
    expect(s.refresh).toHaveBeenCalledTimes(2);
    expect(s.select).toHaveBeenCalledWith(address.id);
    s.scope.stop();
  });
  it.each(['切卡', '手工选址', '切换仅登录', '身份切换'])('%s后迟到结果不覆盖表单', async () => {
    let finish!: (value: unknown) => void;
    mock.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const s = setup();
    const pending = s.hook.generate();
    s.context.value = 'changed';
    finish({ count: 1, items: [address] });
    await pending;
    expect(s.select).not.toHaveBeenCalled();
    s.scope.stop();
  });
  it('锁定和已绑定卡不允许生成，切页后迟到结果也不回填', async () => {
    const s = setup();
    s.allowed.value = false;
    await s.hook.generate();
    expect(mock.generate).not.toHaveBeenCalled();
    s.allowed.value = true;
    let finish!: (value: unknown) => void;
    mock.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = s.hook.generate();
    s.scope.stop();
    finish({ count: 1, items: [address] });
    await pending;
    expect(s.select).not.toHaveBeenCalled();
  });
});
