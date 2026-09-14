import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = readFileSync(new URL('./VendureMailboxManager.vue', import.meta.url), 'utf8');
const routeView = readFileSync(new URL('./V2VendureMailboxView.vue', import.meta.url), 'utf8');
const api = readFileSync(new URL('./vendure-mailbox-api.ts', import.meta.url), 'utf8');

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
