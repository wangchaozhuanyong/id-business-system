import { randomBytes } from 'node:crypto';

// PAY-GPT-UPGRADE ba6cf963 (MIT): 保留原 KC- 格式、字符集、100 个上限及批次内去重。
const CDK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function createOnlineRechargeCodes(count: unknown): string[] {
  const results = new Set<string>();
  const target = Math.max(1, Math.min(Number(count) || 1, 100));
  while (results.size < target) {
    const bytes = randomBytes(15);
    let suffix = '';
    for (let i = 0; i < bytes.length; i++) suffix += CDK_CHARSET[bytes[i] % CDK_CHARSET.length];
    results.add(`KC-${suffix}`);
  }
  return [...results];
}
