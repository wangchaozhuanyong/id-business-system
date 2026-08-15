import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('personal workspace UI contract', () => {
  const layout = read('../../layouts/V2AdminLayout.vue');
  const launcher = read('./V2WorkspaceLauncher.vue');
  const shortcutDrawer = read('./V2WorkspaceShortcutDrawer.vue');
  const totpDrawer = read('./V2TotpToolDrawer.vue');
  const mailViewerDrawer = read('./V2MailViewerDrawer.vue');
  const mailQueryPanel = read('./V2MailQueryPanel.vue');
  const managedMailboxPanel = read('./V2ManagedMailboxPanel.vue');
  const mailMessageList = read('./V2MailMessageList.vue');
  const publicMailboxView = read('../../views/V2PublicMailboxView.vue');
  const workspaceFixtureEntry = read('../../testing/workspace-design-fixture.ts');
  const workspaceApi = read('../../api/workspace.ts');

  it('mounts one fixed workspace launcher outside the scrollable navigation', () => {
    const navigationEnd = layout.indexOf('</nav>');
    const launcherIndex = layout.indexOf('<V2WorkspaceLauncher');
    const asideEnd = layout.indexOf('</aside>');
    expect(navigationEnd).toBeGreaterThan(0);
    expect(launcherIndex).toBeGreaterThan(navigationEnd);
    expect(launcherIndex).toBeLessThan(asideEnd);
  });

  it('opens external shortcuts without routing through the application', () => {
    expect(launcher).toContain("window.open(item.url, '_blank', 'noopener,noreferrer')");
    expect(launcher).not.toContain('router.push');
  });

  it('keeps tools and shortcut management in right-side drawers', () => {
    expect(launcher).toContain('<V2WorkspaceShortcutDrawer');
    expect(launcher).toContain('<V2TotpToolDrawer');
    expect(launcher).toContain('<V2MailViewerDrawer');
    expect(shortcutDrawer).toContain('<el-drawer');
    expect(totpDrawer).toContain('<el-drawer');
    expect(mailViewerDrawer).toContain('<el-drawer');
    expect(shortcutDrawer).toContain('append-to-body');
    expect(totpDrawer).toContain('append-to-body');
    expect(mailViewerDrawer).toContain('append-to-body');
    expect(totpDrawer).toContain('size="min(620px, 100vw)"');
  });

  it('does not persist or transmit TOTP input', () => {
    expect(totpDrawer).not.toMatch(/localStorage|sessionStorage|idBusinessV2WorkspaceApi|http\./);
    expect(totpDrawer).toContain('getV2BusinessNowMs() ?? Date.now()');
    expect(totpDrawer).toContain('@closed="clearAll"');
  });

  it('aligns the TOTP input frame with the full drawer content width', () => {
    expect(totpDrawer).toContain('label-position="left"');
    expect(totpDrawer).toContain('class="v2-totp-input__field"');
    expect(totpDrawer).toMatch(/\.v2-totp-input__field\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  });

  it('keeps each TOTP result in one row without exposing a secret summary', () => {
    expect(totpDrawer).toContain('v2-totp-result__line');
    expect(totpDrawer).toContain('v2-totp-result__countdown');
    expect(totpDrawer).toContain('v2-totp-result__token');
    expect(totpDrawer).toContain('v2-totp-result__copy');
    expect(totpDrawer).toContain('account.lineNumber');
    expect(totpDrawer).not.toContain('account.maskedSecret');
    expect(totpDrawer).not.toContain('v2-totp-result__timer');
  });

  it('uses the first-party mailbox pool and never renders provider HTML', () => {
    expect(mailViewerDrawer).toContain('查询由本系统验证');
    expect(mailViewerDrawer).toContain('@closed="clearAll"');
    expect(mailViewerDrawer).toContain('label="邮件查询"');
    expect(mailViewerDrawer).toContain('label="邮箱池管理"');
    expect(mailQueryPanel).toContain('placeholder="邮箱----邮件查询码"');
    expect(mailQueryPanel).toContain('autocomplete="new-password"');
    expect(managedMailboxPanel).toContain('应用专用密码');
    expect(managedMailboxPanel).toContain('<V2AsyncRegion');
    expect(publicMailboxView).toContain('<V2MailQueryPanel');
    expect(mailMessageList).toContain('mailBodyToPlainText(item.body)');
    expect(
      [mailViewerDrawer, mailQueryPanel, managedMailboxPanel, mailMessageList].join('\n')
    ).not.toMatch(/v-html|localStorage|sessionStorage/);
    expect(workspaceApi).toContain('/public/mailbox/query');
    expect(workspaceApi).not.toContain('icloud.thefindnet.xyz');
  });

  it('seeds the workspace fixture admin session before mounting child tools', () => {
    const hydrateIndex = workspaceFixtureEntry.indexOf('sessionCoordinator.hydrate()');
    const readyIndex = workspaceFixtureEntry.indexOf("kind: 'ready'");
    const mountIndex = workspaceFixtureEntry.indexOf(".mount('#app')");
    expect(hydrateIndex).toBeGreaterThan(0);
    expect(readyIndex).toBeGreaterThan(hydrateIndex);
    expect(mountIndex).toBeGreaterThan(readyIndex);
  });
});
