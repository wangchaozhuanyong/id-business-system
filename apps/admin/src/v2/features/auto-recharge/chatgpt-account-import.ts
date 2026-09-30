export interface ChatgptAccountImportRow {
  email: string;
  password: string;
  totpSecret: string;
  remark: string;
}

// 一行一个账号。Tab 可留空列；空格分隔时用「-」占位可选的 2FA。
export function parseChatgptAccountImport(text: string): ChatgptAccountImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 1 || lines.length > 200) throw new Error('请粘贴 1 至 200 行账号资料');
  return lines.map((line, index) => {
    const parts = line.includes('\t')
      ? line.split('\t').map((part) => part.trim())
      : line.split(/\s+/);
    const [email = '', password = '', totpSecret = ''] = parts;
    const remark = parts.slice(3).join(' ').trim();
    if (!email || !password || (parts.length > 4 && line.includes('\t'))) {
      throw new Error(`第 ${index + 1} 行格式无效：需要邮箱和密码，最多四列`);
    }
    return {
      email,
      password,
      totpSecret: totpSecret === '-' ? '' : totpSecret,
      remark: remark === '-' ? '' : remark
    };
  });
}
