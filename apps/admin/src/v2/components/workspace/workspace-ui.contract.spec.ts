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
  const savedTotpAccounts = read('./V2SavedTotpAccounts.vue');
  const mailViewerDrawer = read('./V2MailViewerDrawer.vue');
  const relayScriptDrawer = read('./V2RelayScriptDrawer.vue');
  const relayConnectionPanel = read('./V2RelayConnectionPanel.vue');
  const relayDeploymentPanel = read('./V2RelayDeploymentPanel.vue');
  const mailQueryPanel = read('./V2MailQueryPanel.vue');
  const managedMailboxPanel = read('./V2ManagedMailboxPanel.vue');
  const managedMailboxBatchDrawer = read('./V2ManagedMailboxBatchDrawer.vue');
  const managedMailboxExpiry = read('./managedMailboxExpiry.ts');
  const mailMessageList = read('./V2MailMessageList.vue');
  const publicMailboxView = read('../../views/V2PublicMailboxView.vue');
  const router = read('../../../v2-router.ts');
  const loginView = read('../../views/V2LoginView.vue');
  const workspaceFixtureEntry = read('../../testing/workspace-design-fixture.ts');
  const workspaceApi = read('../../api/workspace.ts');
  const baseCss = read('../../styles/base.css');

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

  it('shows a tall two-column shortcut grid without redundant headings', () => {
    expect(launcher).toContain('height: min(720px, calc(100dvh - 92px))');
    expect(launcher).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(launcher).not.toContain('常用入口与在线工具');
    expect(launcher).not.toContain('<span>快捷网址</span>');
    expect(shortcutDrawer).toContain('.v2-workspace-shortcut-drawer__toolbar > div > span');
    expect(shortcutDrawer).not.toContain('.v2-workspace-shortcut-drawer__toolbar span,');
  });

  it('keeps tools and shortcut management in right-side drawers', () => {
    expect(launcher).toContain('<V2WorkspaceShortcutDrawer');
    expect(launcher).toContain('<V2TotpToolDrawer');
    expect(launcher).toContain('<V2MailViewerDrawer');
    expect(launcher).toContain('<V2RelayScriptDrawer');
    expect(launcher).toContain('<strong>中转脚本</strong>');
    expect(launcher).toContain('v-if="isAdmin"');
    expect(launcher).toContain('邮箱查询与邮箱池');
    expect(launcher).toContain('openMailViewerTool');
    expect(launcher).not.toMatch(/class="v2-workspace-panel__tool is-mail-viewer"[^>]*disabled/s);
    expect(shortcutDrawer).toContain('<el-drawer');
    expect(totpDrawer).toContain('<el-drawer');
    expect(mailViewerDrawer).toContain('<el-drawer');
    expect(relayScriptDrawer).toContain('<el-drawer');
    expect(shortcutDrawer).toContain('append-to-body');
    expect(totpDrawer).toContain('append-to-body');
    expect(mailViewerDrawer).toContain('append-to-body');
    expect(relayScriptDrawer).toContain('append-to-body');
    expect(totpDrawer).toContain('size="min(640px, 100%)"');
  });

  it('keeps the online relay workflow encrypted, resumable, and admin-only', () => {
    const relayUi = [relayScriptDrawer, relayConnectionPanel, relayDeploymentPanel].join('\n');
    expect(relayScriptDrawer).toContain('在线自动部署 Google Cloud Vertex 账号到中转站');
    expect(relayUi).toContain('label-position="left"');
    expect(relayUi).toContain('require-asterisk-position="right"');
    expect(relayUi).toContain('<V2AsyncRegion');
    expect(relayUi).toContain('创建并自动执行');
    expect(relayUi).toContain('继续自动执行');
    expect(relayScriptDrawer).toContain(':before-close="beforeClose"');
    expect(relayUi).not.toMatch(/localStorage|sessionStorage|v-loading|el-skeleton/);
    expect(workspaceApi).toContain('/id-business-v2/workspace-relay');
  });

  it('keeps temporary TOTP input in component memory until the user clears it', () => {
    expect(totpDrawer).not.toMatch(/localStorage|sessionStorage|idBusinessV2WorkspaceApi|http\./);
    expect(totpDrawer).toContain('getV2BusinessNowMs() ?? Date.now()');
    expect(totpDrawer).toContain('close-on-click-modal');
    expect(totpDrawer).toContain('@click="clearAll"');
    expect(totpDrawer).not.toContain('destroy-on-close');
    expect(totpDrawer).not.toContain('ElMessageBox.confirm');
  });

  it('manages encrypted personal TOTP accounts without returning saved secrets', () => {
    expect(totpDrawer).toContain('<V2SavedTotpAccounts');
    expect(totpDrawer).toContain('v-if="syncServerTime"');
    expect(savedTotpAccounts).toContain('<V2AsyncRegion');
    expect(savedTotpAccounts).toContain('label-position="left"');
    expect(savedTotpAccounts).toContain('require-asterisk-position="right"');
    expect(savedTotpAccounts).toContain('idBusinessV2WorkspaceApi.listTotpAccounts');
    expect(savedTotpAccounts).toContain('idBusinessV2WorkspaceApi.createTotpAccount');
    expect(savedTotpAccounts).toContain('idBusinessV2WorkspaceApi.updateTotpAccount');
    expect(savedTotpAccounts).toContain('idBusinessV2WorkspaceApi.removeTotpAccount');
    expect(savedTotpAccounts).toContain('搜索账号名称或签发方');
    expect(savedTotpAccounts).toContain('V2_SAVED_TOTP_ACCOUNT_LIMITS.count');
    expect(savedTotpAccounts).toContain('<el-pagination');
    expect(savedTotpAccounts).toContain('SAVED_TOTP_PAGE_SIZE = 8');
    expect(savedTotpAccounts).toContain('v-for="item in paginatedItems"');
    expect(savedTotpAccounts).toContain('v2-saved-totp-card__details');
    expect(savedTotpAccounts).toContain('variant="success"');
    expect(savedTotpAccounts).toContain('密钥加密保存在服务器');
    expect(savedTotpAccounts).toContain('同一账号换电脑仍可使用');
    expect(savedTotpAccounts).not.toMatch(/secretEncrypted|secretHash|localStorage|sessionStorage/);
  });

  it('keeps the time calibration state in the drawer header without a security panel', () => {
    expect(totpDrawer).toContain('<template #header>');
    expect(totpDrawer).toContain('v2-totp-drawer__header');
    expect(totpDrawer).toContain('v2-totp-time-status');
    expect(totpDrawer).not.toContain('v2-totp-security-panel');
  });

  it('exposes the local TOTP tool on the public login page', () => {
    expect(loginView).toContain(
      '<V2TotpToolDrawer v-model="totpToolOpen" :sync-server-time="false" />'
    );
    expect(loginView).toContain('native-type="button"');
    expect(loginView).toContain('@click="totpToolOpen = true"');
    expect(loginView).toContain('在线计算 2FA 验证码');
    expect(totpDrawer).toContain('if (!props.syncServerTime)');
  });

  it('keeps TOTP labels on the left and separates single from batch queries', () => {
    expect(totpDrawer).toContain('label-position="left"');
    expect(totpDrawer).toContain('value="single"');
    expect(totpDrawer).toContain('value="batch"');
    expect(totpDrawer).toContain('v2-totp-quick-query');
    expect(totpDrawer).toContain('v2-totp-batch-input');
    expect(totpDrawer).toContain('一键粘贴');
    expect(totpDrawer).toContain('@paste="handleSinglePaste"');
    expect(totpDrawer).toContain('applyPastedInput(clipboardText)');
    expect(totpDrawer).toContain('粘贴后自动生成');
    expect(totpDrawer).not.toContain('class="v2-totp-query-button"');
  });

  it('keeps teleported workspace drawers on an opaque themed surface', () => {
    expect(baseCss).toMatch(/:root\s*\{[^}]*--v2-surface:\s*var\(--v3-surface\)/s);
    expect(baseCss).toMatch(/:root\s*\{[^}]*--v2-text:\s*var\(--v3-text\)/s);
    expect(baseCss).toMatch(/:root\s*\{[^}]*--v2-border:\s*var\(--v3-border\)/s);
  });

  it('shows readable TOTP result cards without exposing a secret summary', () => {
    expect(totpDrawer).toContain('v2-totp-result-card');
    expect(totpDrawer).toContain('v2-totp-result__countdown');
    expect(totpDrawer).toContain('v2-totp-result__token');
    expect(totpDrawer).toContain('v2-totp-result__copy');
    expect(totpDrawer).toContain('v2-totp-result__progress');
    expect(totpDrawer).toContain('临时查询验证码');
    expect(totpDrawer).toContain('role="progressbar"');
    expect(totpDrawer).toContain('account.lineNumber');
    expect(totpDrawer).not.toContain('account.maskedSecret');
  });

  it('keeps mailbox query as a production-ready module in workspace tools', () => {
    expect(mailViewerDrawer).toContain('查询由本系统验证');
    expect(mailViewerDrawer).toContain('close-on-click-modal');
    expect(mailViewerDrawer).not.toContain('destroy-on-close');
    expect(mailViewerDrawer).not.toContain('ElMessageBox.confirm');
    expect(mailViewerDrawer).toContain('label="邮件查询"');
    expect(mailViewerDrawer).toContain('label="邮箱池管理"');
    expect(mailQueryPanel).toContain('placeholder="请输入邮件查询码"');
    expect(mailQueryPanel).toContain('label="邮件查询码"');
    expect(mailQueryPanel).toContain('autocomplete="new-password"');
    expect(managedMailboxPanel).toContain('应用专用密码');
    expect(managedMailboxPanel).toContain('保存后加密存入服务器，换电脑仍可使用');
    expect(managedMailboxPanel).toContain('Google 生成的 16 位应用专用密码');
    expect(managedMailboxPanel).toContain('Apple 生成的应用专用密码');
    expect(managedMailboxPanel).toContain('查询码有效期');
    expect(managedMailboxPanel).toContain('有效期设置');
    expect(managedMailboxExpiry).toContain('剩余 ${hours}小时');
    expect(managedMailboxPanel).toContain('查询码到期后不会自动更换');
    expect(managedMailboxPanel).toContain('生成并复制');
    expect(managedMailboxPanel).toContain('复制查询码');
    expect(managedMailboxPanel).toContain("document.execCommand('copy')");
    expect(managedMailboxPanel).not.toContain('旧码末四位');
    expect(managedMailboxPanel).toContain('<V2AsyncRegion');
    expect(managedMailboxPanel).toContain('<V2Table');
    expect(managedMailboxPanel).toContain('<V2TableActionColumn');
    expect(managedMailboxPanel).toContain('<el-pagination');
    expect(managedMailboxPanel).toContain('复制 ${row.email} 的买家查询码');
    expect(managedMailboxPanel).toContain('连接 Microsoft 并添加');
    expect(managedMailboxPanel).toContain('<V2ManagedMailboxBatchDrawer');
    expect(managedMailboxBatchDrawer).toContain('批量导入邮箱池');
    expect(managedMailboxBatchDrawer).toContain('每行录入一个邮箱');
    expect(managedMailboxBatchDrawer).toContain('value="microsoft"');
    expect(managedMailboxBatchDrawer).toContain('逐个授权并导入');
    expect(managedMailboxBatchDrawer).toContain('startMicrosoftMailboxAuthorization');
    expect(publicMailboxView).toContain('<V2MailQueryPanel');
    expect(mailMessageList).toContain('mailBodyToPlainText(item.body)');
    expect(
      [mailViewerDrawer, mailQueryPanel, managedMailboxPanel, mailMessageList].join('\n')
    ).not.toMatch(/v-html|localStorage|sessionStorage/);
    expect(workspaceApi).toContain('/public/mailbox/query');
    expect(workspaceApi).toContain('/microsoft/authorizations');
    expect(workspaceApi).not.toContain('icloud.thefindnet.xyz');
    expect(launcher).not.toContain('邮件服务部署后启用');
    expect(router).toContain('V2PublicMailboxView');
    expect(router).toContain("path: '/mailbox'");
    expect(router).toContain('publicStandalone');
  });

  it('keeps the three mailbox pool actions aligned in one compact row', () => {
    const actionsStart = managedMailboxPanel.indexOf(
      '<div class="v2-managed-mailbox-panel__header-actions"'
    );
    const actionsEnd = managedMailboxPanel.indexOf('</div>', actionsStart);
    const actions = managedMailboxPanel.slice(actionsStart, actionsEnd);
    expect(actions.match(/<AppButton/g)).toHaveLength(3);
    expect(actions).toContain('有效期设置');
    expect(actions).toContain('批量导入');
    expect(actions).toContain('刷新');
    expect(actions).not.toContain('icon-only');
    expect(managedMailboxPanel).toContain('grid-template-columns: repeat(3, 116px)');
    expect(managedMailboxPanel).not.toContain('v2-managed-mailbox-panel__form-actions');
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
