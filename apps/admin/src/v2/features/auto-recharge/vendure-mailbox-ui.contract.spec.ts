import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./VendureMailboxManager.vue', import.meta.url), 'utf8');
const routeView = readFileSync(new URL('./V2VendureMailboxView.vue', import.meta.url), 'utf8');
const api = readFileSync(new URL('./vendure-mailbox-api.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./vendure-mailbox.css', import.meta.url), 'utf8');
const tableSchemas = readFileSync(new URL('../tableSchemas.ts', import.meta.url), 'utf8');

describe('Vendure mailbox UI contract', () => {
  it('keeps the same three management areas and the shared V2 interaction primitives', () => {
    expect(routeView).toContain('<VendureMailboxManager');
    expect(view).toContain('主邮箱管理');
    expect(view).toContain('虚拟邮箱管理');
    expect(view).toContain('收件记录');
    expect(view.match(/<V2TableActionColumn/g)).toHaveLength(3);
    expect(view).toContain('<V2AsyncRegion');
    expect(view).toContain('<V2FormDrawer');
    expect(view).toContain('<V2ConfirmDialog');
    expect(view).toContain('label-position="left"');
    expect(view).toContain('require-asterisk-position="right"');
    expect(view).not.toContain('v-loading');
    expect(view).not.toContain('<el-skeleton');
    expect(view).toContain('isPrimaryActionRunning');
    expect(view).toContain('连接正常');
    expect(view).toContain('已有操作正在处理中');
    expect(view).toContain('一键复制');
    expect(view).toContain('操作已完成，但列表刷新失败');
    expect(view).toContain('互通服务连接异常');
    expect(view.match(/class="v2-records-mobile-list"/g)).toHaveLength(3);
    expect(styles).toContain('.vendure-mailbox-toolbar__filters');
    expect(tableSchemas.match(/mobileMode: 'cards'/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('selects a virtual mailbox before opening mail results and exposes the active scope', () => {
    const selectAlias = view.indexOf('virtualEmailId.value = row.id;');
    const openMails = view.indexOf("activeTab.value = 'mails';", selectAlias);

    expect(selectAlias).toBeGreaterThan(-1);
    expect(openMails).toBeGreaterThan(selectAlias);
    expect(view).toContain('当前收件范围');
    expect(view).toContain('仅显示 ${selectedAliasEmail} 的邮件');
    expect(view).toContain('void activeQuery.value.ensureFresh();');
    expect(view).toContain("if (tab === 'mails') void aliasQuery.ensureFresh();");
    expect(view).not.toContain('void nextTick');
  });

  it('connects every displayed management area to the ID server proxy', () => {
    expect(api).toContain("const base = '/id-business-v2/vendure-mailboxes'");
    expect(api).toContain('`${base}/primary-accounts`');
    expect(api).toContain('`${base}/aliases`');
    expect(api).toContain('`${base}/mails`');
    expect(api).not.toContain('VENDURE_MAILBOX_API_KEY');
    expect(api).not.toContain('vendure-api-key');
  });
});
