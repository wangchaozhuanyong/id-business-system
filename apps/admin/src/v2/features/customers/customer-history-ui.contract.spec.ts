import { describe, expect, it } from 'vitest';
import view from './V2CustomersView.vue?raw';
import historyServices from './components/V2CustomerHistoryServices.vue?raw';
import mobileDetails from './components/V2CustomerMobileDetails.vue?raw';
import sensitiveAccessDialog from './components/V2CustomerSensitiveAccessDialog.vue?raw';
import list from './components/V2CustomersList.vue?raw';
import toolbar from './components/V2CustomersToolbar.vue?raw';
import tableSchemas from '@/v2/features/tableSchemas.ts?raw';

describe('customer history and contact UI contract', () => {
  it('shows QQ and masked WhatsApp on desktop and mobile', () => {
    expect(view).toContain('label="QQ"');
    expect(view).toContain('label="WhatsApp"');
    expect(mobileDetails).toContain('<dt>QQ</dt>');
    expect(mobileDetails).toContain('<dt>WhatsApp</dt>');
    expect(list).toContain('row.maskedWhatsapp');
    expect(list).toContain('openRevealWhatsapp');
    expect(tableSchemas).toContain("key: 'qq'");
    expect(tableSchemas).toContain("label: 'WhatsApp'");
  });

  it('labels activation-backed data as history and does not expose manual editing', () => {
    expect(toolbar).toContain('筛选历史开通业务');
    expect(toolbar).toContain('v-model="page.query.serviceOptionId"');
    expect(historyServices).toContain('serviceHistoryTitle(service)');
    expect(view).not.toContain('form.serviceOptionIds');
    expect(view).not.toContain('常开业务');
    expect(tableSchemas).toContain("label: '历史开通业务'");
    expect(tableSchemas).not.toContain('常开业务');
  });

  it('explains the keep and clear behavior for stored WhatsApp', () => {
    expect(view).toContain('留空保持原 WhatsApp');
    expect(view).toContain('清空已保存 WhatsApp');
    expect(sensitiveAccessDialog).toContain(
      "revealField === 'phone' ? '查看完整手机号' : '查看完整 WhatsApp'"
    );
  });
});
