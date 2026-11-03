import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configGroups } from './configFields';
import { onlineActionAllowedForRow } from './sections';
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
describe('比特代充管理界面', () => {
  it('提供三种执行通道及两种单选付款模式，默认人工核对', () => {
    const fields = configGroups.flatMap((group) => group.fields);
    expect(
      fields.find((field) => field.key === 'executionChannel')?.options?.map((item) => item.value)
    ).toEqual(['local', 'third_party', 'bitbrowser']);
    expect(fields.find((field) => field.key === 'bitBrowserPaymentMode')).toMatchObject({
      type: 'radio',
      initial: 'manual'
    });
    expect(fields.find((field) => field.key === 'bitBrowserQueueLimit')).toMatchObject({
      initial: 100
    });
    for (const plan of ['Plus', 'Pro5x', 'Pro20x'])
      expect(fields.find((field) => field.key === `bitBrowser${plan}MaxAmount`)?.initial).toBe('');
  });
  it('配对凭据只保留在当前组件临时状态，不进入会话草稿', () => {
    const source = read('./OnlineBitbrowserDevicePanel.vue');
    expect(source).toContain('ref<BitbrowserPairing | null>(null)');
    expect(source).toContain('subscribeIdentityChange');
    expect(source).not.toMatch(/draft\.form\.(?:pairingToken|deviceKey)/);
  });
  it('付款确认绑定报价摘要和版本，不引入查看原因或审批', () => {
    const source = read('./OnlineBitbrowserPaymentPanel.vue');
    expect(source).toContain('quote.value.digest');
    expect(source).toContain('quote.value.version');
    expect(source).not.toMatch(/查看原因|申请原因|approvalId/);
  });
  it('后台可指定电脑，接口密钥按电脑隔离且不进入会话草稿', () => {
    expect(
      configGroups
        .flatMap((group) => group.fields)
        .find((field) => field.key === 'bitBrowserDeviceId')
    ).toMatchObject({ type: 'select' });
    const source = read('./OnlineBitbrowserConnectionDrawer.vue');
    expect(source).toContain("apiKey = ref('')");
    expect(source).not.toMatch(/draft\.form\.(?:apiKey|localApiToken)/);
    expect(read('./OnlineBitbrowserDevicePanel.vue')).toContain("downloadBackgroundSetup('mac')");
    expect(read('./OnlineBitbrowserDevicePanel.vue')).toContain(
      "downloadBackgroundSetup('windows')"
    );
  });
  it('只有待执行任务或尚未付款的运行中比特任务可取消', () => {
    const action = { key: 'cancel', label: '取消任务' };
    expect(
      onlineActionAllowedForRow('jobs', action, {
        id: 'fixture',
        provider: 'bitbrowser',
        status: 'running',
        paymentStarted: false
      })
    ).toBe(true);
    expect(
      onlineActionAllowedForRow('jobs', action, {
        id: 'fixture',
        provider: 'bitbrowser',
        status: 'running',
        paymentStarted: true
      })
    ).toBe(false);
    expect(
      onlineActionAllowedForRow('jobs', action, {
        id: 'fixture',
        provider: 'local',
        status: 'running'
      })
    ).toBe(false);
  });
});
