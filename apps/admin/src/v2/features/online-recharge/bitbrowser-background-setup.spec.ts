import { describe, expect, it } from 'vitest';
import { backgroundSetupArchive } from './bitbrowser-background-setup';
function unpack(platform: 'mac' | 'windows') {
  const data = backgroundSetupArchive(platform),
    view = new DataView(data.buffer);
  const nameSize = view.getUint16(26, true),
    bodySize = view.getUint32(18, true);
  const decoder = new TextDecoder();
  const name = decoder.decode(data.subarray(30, 30 + nameSize));
  const content = decoder.decode(data.subarray(30 + nameSize, 30 + nameSize + bodySize));
  const central = 30 + nameSize + bodySize;
  return { name, content, view, central };
}
describe('网站下载一次性后台设置入口', () => {
  it('Mac 入口保留可执行位且无 BOM，无需日常输入命令', () => {
    const zip = unpack('mac');
    expect(zip.name).toBe('设置后台启动.command');
    expect(zip.content.startsWith('#!/bin/sh\n')).toBe(true);
    expect((zip.view.getUint32(zip.central + 38, true) >>> 16) & 0o777).toBe(0o755);
    expect(zip.content).toContain('setup-online-bitbrowser.command');
    expect(zip.content).not.toMatch(/deviceKey|pairingToken|password|curl/);
  });
  it('Windows 入口通过文件夹选择器接入原助手，不修改系统执行策略', () => {
    const zip = unpack('windows');
    expect(zip.name.endsWith('.cmd')).toBe(true);
    expect(zip.content).toContain('FolderBrowserDialog');
    expect(zip.content).toContain('setup-online-bitbrowser.cmd');
    expect(zip.content).not.toMatch(/ExecutionPolicy|deviceKey|pairingToken/);
  });
});
