import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { idBusinessV2PublicMailboxApi } from '@/v2/api/workspace';
import V2PublicMailboxView from '@/v2/views/V2PublicMailboxView.vue';

Object.assign(idBusinessV2PublicMailboxApi, {
  query: async ({ queryCode }: { queryCode: string; limit: number }) => ({
    codeExpiresAt: '2026-10-14T00:00:00.000Z',
    email: /^MSTR-/i.test(queryCode) ? 'owner@icloud.com' : 'buyer-01@icloud.com',
    items: Array.from({ length: 5 }, (_, index) => ({
      id: `mail-${index + 1}`,
      body: `这是第 ${index + 1} 封设计验收邮件的纯文本正文。`,
      extractedCode: String(681240 + index),
      from: index % 2 ? 'OpenAI <noreply@openai.com>' : 'Apple <account@apple.com>',
      savedAt: `2026-09-14T${String(13 - index).padStart(2, '0')}:05:00.000Z`,
      subject: index % 2 ? '您的登录验证码' : 'Apple ID 验证码',
      to: index < 3 ? 'buyer-01@icloud.com' : 'buyer-02@icloud.com',
      virtualEmailId: index < 3 ? 'alias-1' : 'alias-2'
    })),
    maxVisibleMessages: /^BUY-/i.test(queryCode) ? 5 : null,
    provider: 'icloud',
    queriedAt: '2026-09-14T13:06:00.000Z',
    remainingDays: 28,
    targetType: /^MSTR-/i.test(queryCode) ? 'PRIMARY' : 'VIRTUAL',
    totalEmails: 5,
    virtualEmailsList: /^MSTR-/i.test(queryCode)
      ? [
          { id: 'alias-1', aliasEmail: 'buyer-01@icloud.com', note: '订单 1' },
          { id: 'alias-2', aliasEmail: 'buyer-02@icloud.com', note: '订单 2' }
        ]
      : null
  })
});

createApp(V2PublicMailboxView).mount('#app');
