<template>
  <div class="v2-shell v2-vendure-mailbox-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
        </div>
      </div>
      <nav class="v2-navigation" aria-label="设计验收导航">
        <section class="v2-navigation__section is-open is-active">
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><CreditCard /></el-icon>
            <span class="v2-navigation__parent-label">自动充值</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#mailbox">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">邮件验证码查询</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>邮件验证码查询</h1></div>
        <div class="v2-topbar__utilities"><span>设计验收夹具 · 不连接生产接口</span></div>
      </header>
      <main class="v2-content">
        <div class="v2-content__inner">
          <VendureMailboxManager />
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {
  V2VendureMailboxAlias,
  V2VendureMailboxListQuery,
  V2VendureMailboxMail,
  V2VendureMailboxPage,
  V2VendureMailboxPrimaryAccount,
  V2VendureMailboxPublicQueryResult
} from '@apple-business/shared';
import { ArrowDown, CreditCard } from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import VendureMailboxManager from '@/v2/features/auto-recharge/VendureMailboxManager.vue';
import { vendureMailboxApi } from '@/v2/features/auto-recharge/vendure-mailbox-api';

const fixtureParams = new URLSearchParams(window.location.search);
document.documentElement.dataset.v2Theme = fixtureParams.get('theme') === 'dark' ? 'dark' : 'light';
const empty = fixtureParams.get('state') === 'empty';
const primaryAccounts: V2VendureMailboxPrimaryAccount[] = empty
  ? []
  : [
      {
        id: 'primary-1',
        createdAt: '2026-08-17T08:00:00.000Z',
        updatedAt: '2026-09-14T12:21:00.000Z',
        email: 'mailbox-owner@icloud.com',
        note: '主号1',
        status: 'ACTIVE',
        imapHost: 'imap.mail.me.com',
        imapPort: 993,
        masterQueryCode: 'MSTR-DEMO-2026',
        codeExpiresAt: '2026-10-12T08:00:00.000Z',
        codeResetIntervalDays: 30,
        remainingDays: 28,
        lastQueriedAt: '2026-09-14T12:04:00.000Z',
        lastQueriedIp: null,
        lastSyncedAt: '2026-09-14T12:21:00.000Z',
        lastSyncError: null,
        virtualEmailCount: 10
      }
    ];
const aliases: V2VendureMailboxAlias[] = empty
  ? []
  : Array.from({ length: 23 }, (_, index) => ({
      id: `alias-${index + 1}`,
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: `2026-09-${String(14 - Math.floor(index / 8)).padStart(2, '0')}T12:00:00.000Z`,
      primaryAccountId: 'primary-1',
      primaryAccountEmail: 'mailbox-owner@icloud.com',
      aliasEmail: `customer-${String(index + 1).padStart(2, '0')}@icloud.com`,
      note: index < 5 ? `主号1-虚拟${index + 1}号` : `Z1-GPT${index + 1}`,
      status: index === 8 ? 'DISABLED' : 'ACTIVE',
      buyerQueryCode: `BUY-${String(index + 1).padStart(2, '0')}K9-${String(91 - index).padStart(2, '0')}QP`,
      codeExpiresAt: '2026-10-12T08:00:00.000Z',
      codeResetIntervalDays: 30,
      remainingDays: 28 + (index % 3),
      lastQueriedAt: null,
      lastQueriedIp: null,
      mailCount: index % 3 === 0 ? 4 : 2,
      lastMailReceivedAt: `2026-09-14T${String(13 - (index % 6)).padStart(2, '0')}:05:00.000Z`
    }));
const mails: V2VendureMailboxMail[] = empty
  ? []
  : Array.from({ length: 28 }, (_, index) => ({
      id: `mail-${index + 1}`,
      createdAt: `2026-09-14T${String(13 - (index % 6)).padStart(2, '0')}:05:00.000Z`,
      updatedAt: `2026-09-14T${String(13 - (index % 6)).padStart(2, '0')}:05:00.000Z`,
      primaryAccountId: 'primary-1',
      virtualEmailId: index === 27 ? null : `alias-${(index % 10) + 1}`,
      messageId: `fixture-message-${index + 1}`,
      fromAddress: index % 2 ? 'noreply@openai.com' : 'account@apple.com',
      fromName: index % 2 ? 'OpenAI' : 'Apple',
      subject: index % 2 ? '您的登录验证码' : 'Apple ID 验证码',
      bodyText: `这是设计验收使用的第 ${index + 1} 封示例邮件。`,
      extractedCode: String(832140 + index),
      receivedAt: `2026-09-14T${String(13 - (index % 6)).padStart(2, '0')}:05:00.000Z`,
      isRead: false,
      isStarred: false
    }));

function page<T>(items: T[], query: V2VendureMailboxListQuery): V2VendureMailboxPage<T> {
  const pageNumber = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return {
    items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    total: items.length,
    page: pageNumber,
    pageSize
  };
}

function includesQuery(values: Array<string | null>, query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || values.some((value) => value?.toLocaleLowerCase().includes(normalized));
}

Object.assign(vendureMailboxApi, {
  status: async () => ({ configured: true, connected: true, message: null }),
  primaryAccounts: async (query: V2VendureMailboxListQuery) =>
    page(
      primaryAccounts.filter(
        (item) =>
          (!query.status || item.status === query.status) &&
          includesQuery([item.email, item.note], query.q ?? '')
      ),
      query
    ),
  aliases: async (query: V2VendureMailboxListQuery) =>
    page(
      aliases.filter(
        (item) =>
          (!query.primaryAccountId || item.primaryAccountId === query.primaryAccountId) &&
          (!query.status || item.status === query.status) &&
          includesQuery([item.aliasEmail, item.primaryAccountEmail, item.note], query.q ?? '')
      ),
      query
    ),
  mails: async (query: V2VendureMailboxListQuery) =>
    page(
      mails.filter(
        (item) =>
          (!query.primaryAccountId || item.primaryAccountId === query.primaryAccountId) &&
          (!query.virtualEmailId || item.virtualEmailId === query.virtualEmailId) &&
          (!query.unassignedOnly || item.virtualEmailId === null) &&
          includesQuery(
            [item.fromAddress, item.fromName, item.subject, item.extractedCode],
            query.q ?? ''
          )
      ),
      query
    ),
  testPrimary: async () => ({ success: true, message: 'iCloud 连接测试成功' }),
  syncPrimary: async () => ({ success: true, syncedCount: 2, error: null }),
  publicQuery: async (queryCode: string): Promise<V2VendureMailboxPublicQueryResult> => {
    if (queryCode === 'INVALID') throw new Error('查询码无效');
    if (queryCode === 'SLOW-DEMO') await new Promise((resolve) => setTimeout(resolve, 600));
    const isMaster = queryCode.startsWith('MSTR');
    const scopedMails = isMaster
      ? mails
      : mails.filter((mail) => mail.virtualEmailId === 'alias-1');
    return {
      success: true,
      message: null,
      targetType: isMaster ? 'MASTER' : 'BUYER',
      aliasEmail: queryCode === 'SLOW-DEMO' ? 'slow@icloud.com' : 'customer-01@icloud.com',
      primaryEmail: 'mailbox-owner@icloud.com',
      codeExpiresAt: '2026-10-12T08:00:00.000Z',
      remainingDays: 28,
      totalEmails: scopedMails.length,
      items: scopedMails.slice(0, 5).map((mail) => ({
        id: mail.id,
        virtualEmailId: mail.virtualEmailId,
        fromAddress: mail.fromAddress,
        fromName: mail.fromName ?? '',
        subject: mail.subject,
        receivedAt: mail.receivedAt,
        extractedCode: mail.extractedCode,
        bodyText: mail.bodyText,
        targetEmail:
          aliases.find((alias) => alias.id === mail.virtualEmailId)?.aliasEmail ??
          'mailbox-owner@icloud.com'
      })),
      virtualEmailsList: null
    };
  }
});
</script>

<style scoped>
@media (max-width: 900px) {
  .v2-vendure-mailbox-design-fixture {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-vendure-mailbox-design-fixture > .v2-sidebar {
    display: none;
  }

  .v2-vendure-mailbox-design-fixture > .v2-workspace {
    min-width: 0;
  }
}
</style>
