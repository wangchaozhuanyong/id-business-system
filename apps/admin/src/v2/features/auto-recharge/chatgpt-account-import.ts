export interface ChatgptAccountImportRow {
  email: string;
  password: string;
  totpSecret: string;
  remark: string;
}

export type ChatgptAccountImportFormat = 'with_password' | 'without_password';

// 显式选择列格式，避免将看似 Base32 密钥的密码误识别为 2FA。
export function parseChatgptAccountImport(
  text: string,
  format: ChatgptAccountImportFormat = 'with_password'
): ChatgptAccountImportRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 1 || lines.length > 200) throw new Error('请粘贴 1 至 200 行账号资料');
  return lines.map((line, index) => {
    const parts = line.includes('\t')
      ? line.split('\t').map((part) => part.trim())
      : line.trim().split(/\s+/);
    const withoutPassword = format === 'without_password';
    const email = parts[0] ?? '';
    const password = withoutPassword ? '' : (parts[1] ?? '');
    const totpSecret = parts[withoutPassword ? 1 : 2] ?? '';
    const remark = parts
      .slice(withoutPassword ? 2 : 3)
      .join(' ')
      .trim();
    const maxColumns = withoutPassword ? 3 : 4;
    if (!email || (parts.length > maxColumns && line.includes('\t'))) {
      throw new Error(
        `第 ${index + 1} 行格式无效：需要邮箱，最多${withoutPassword ? '三' : '四'}列`
      );
    }
    return {
      email,
      password: password === '-' ? '' : password,
      totpSecret: totpSecret === '-' ? '' : totpSecret,
      remark: remark === '-' ? '' : remark
    };
  });
}
