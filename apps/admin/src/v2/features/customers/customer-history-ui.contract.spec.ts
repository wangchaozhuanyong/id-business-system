import { describe, expect, it } from 'vitest';
import view from './V2CustomersView.vue?raw';
import historyServices from './components/V2CustomerHistoryServices.vue?raw';
import mobileDetails from './components/V2CustomerMobileDetails.vue?raw';
import manifest from './manifest.ts?raw';

describe('customer history and contact UI contract', () => {
  it('shows QQ and masked WhatsApp on desktop and mobile', () => {
    expect(view).toContain('label="QQ"');
    expect(view).toContain('label="WhatsApp"');
    expect(mobileDetails).toContain('<dt>QQ</dt>');
    expect(mobileDetails).toContain('<dt>WhatsApp</dt>');
    expect(view).toContain('row.maskedWhatsapp');
    expect(view).toContain('openRevealWhatsapp');
    expect(manifest).toContain("key: 'qq'");
    expect(manifest).toContain("key: 'whatsapp'");
  });

  it('labels activation-backed data as history and does not expose manual editing', () => {
    expect(view).toContain('历史开通业务');
    expect(view).toContain('v-model="query.serviceOptionId"');
    expect(historyServices).toContain('serviceHistoryTitle(service)');
    expect(view).not.toContain('form.serviceOptionIds');
    expect(view).not.toContain('常开业务');
    expect(manifest).toContain("key: 'historicalService'");
    expect(manifest).not.toContain('常开业务');
  });

  it('explains the keep and clear behavior for stored WhatsApp', () => {
    expect(view).toContain('留空保持原 WhatsApp');
    expect(view).toContain('清空已保存 WhatsApp');
    expect(view).toContain("revealField === 'phone' ? '查看完整手机号' : '查看完整 WhatsApp'");
  });
});
