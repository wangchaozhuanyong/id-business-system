// ZIP 保留 Mac 启动入口的可执行权限；安装包不包含配对凭据。
const encoder = new TextEncoder();
const macLauncher = `#!/bin/sh
set -eu
assistant_dir=$(/usr/bin/osascript -e 'POSIX path of (choose folder with prompt "选择已安装的充值助手文件夹")')
entry="$assistant_dir/scripts/setup-online-bitbrowser.command"
if [ ! -f "$entry" ]; then
  /usr/bin/osascript -e 'display dialog "所选文件夹缺少新版充值助手，请重新选择。" buttons {"知道了"}'
  exit 2
fi
exec /bin/sh "$entry"
`;
const windowsLauncher = `@echo off\r
chcp 65001 >nul\r
powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择已安装的充值助手文件夹'; if ($d.ShowDialog() -eq 'OK') { $entry = Join-Path $d.SelectedPath 'scripts\\setup-online-bitbrowser.cmd'; if (Test-Path -LiteralPath $entry) { & $env:ComSpec /d /c ([char]34 + $entry + [char]34) } else { [System.Windows.Forms.MessageBox]::Show('所选文件夹缺少新版充值助手，请重新选择。') | Out-Null } }"\r
`;

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function backgroundSetupArchive(platform: 'mac' | 'windows') {
  const name = encoder.encode(platform === 'mac' ? '设置后台启动.command' : 'setup-background.cmd');
  const body = encoder.encode(platform === 'mac' ? macLauncher : windowsLauncher);
  const localSize = 30 + name.length + body.length;
  const centralSize = 46 + name.length;
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  const crc = crc32(body);
  u32(0, 0x04034b50);
  u16(4, 20);
  u16(6, 0x0800);
  u16(12, 33);
  u32(14, crc);
  u32(18, body.length);
  u32(22, body.length);
  u16(26, name.length);
  bytes.set(name, 30);
  bytes.set(body, 30 + name.length);
  const offset = localSize;
  u32(offset, 0x02014b50);
  u16(offset + 4, 0x0314);
  u16(offset + 6, 20);
  u16(offset + 8, 0x0800);
  u16(offset + 14, 33);
  u32(offset + 16, crc);
  u32(offset + 20, body.length);
  u32(offset + 24, body.length);
  u16(offset + 28, name.length);
  u32(offset + 38, (0o100755 << 16) >>> 0);
  bytes.set(name, offset + 46);
  const end = offset + centralSize;
  u32(end, 0x06054b50);
  u16(end + 8, 1);
  u16(end + 10, 1);
  u32(end + 12, centralSize);
  u32(end + 16, localSize);
  return bytes;
}

export function downloadBackgroundSetup(platform: 'mac' | 'windows') {
  const blob = new Blob([backgroundSetupArchive(platform)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download =
    platform === 'mac' ? 'Mac充值助手一次性设置.zip' : 'Windows充值助手一次性设置.zip';
  link.click();
  URL.revokeObjectURL(url);
}
