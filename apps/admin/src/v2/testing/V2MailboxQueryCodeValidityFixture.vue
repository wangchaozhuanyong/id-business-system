<template>
  <main class="v2-page-layout">
    <el-drawer
      v-if="system === 'managed'"
      :model-value="true"
      title="邮箱查询与管理"
      append-to-body
      size="min(1560px, 100vw)"
    >
      <V2ManagedMailboxPanel />
    </el-drawer>
    <VendureMailboxManager v-else />
  </main>
</template>
<script setup lang="ts">
import type {
  V2ManagedMailbox,
  V2VendureMailboxAlias,
  V2VendureMailboxPrimaryAccount
} from '@apple-business/shared';
import V2ManagedMailboxPanel from '@/v2/components/workspace/V2ManagedMailboxPanel.vue';
import VendureMailboxManager from '@/v2/features/auto-recharge/VendureMailboxManager.vue';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { vendureMailboxApi } from '@/v2/features/auto-recharge/vendure-mailbox-api';

const params = new URLSearchParams(location.search);
const system = params.get('system') ?? 'managed';
document.documentElement.dataset.v2Theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const controls = {
  writes: [] as Array<{ kind: string; id: string; days: number }>,
  failWrite: false,
  failRead: false,
  delayMs: 0
};
(window as typeof window & { mailboxExpiryFixture: typeof controls }).mailboxExpiryFixture =
  controls;
const now = '2026-10-27T08:00:00.000Z';
const oldExpiry = '2026-10-20T08:00:00.000Z';
const managed: V2ManagedMailbox[] = [30, 90].map((days, index) => ({
  id: `managed-${index}`,
  email: `fixture-${index}@example.invalid`,
  label: '模拟邮箱',
  provider: 'gmail',
  status: 'active',
  queryCode: 'FIXTURE-OLD-CODE',
  queryCodeHint: 'CODE',
  queryCodeExpiresAt: oldExpiry,
  queryCodeValidityDays: days,
  lastQueriedAt: null,
  lastVerifiedAt: now,
  createdAt: now,
  updatedAt: now
}));
const primary: V2VendureMailboxPrimaryAccount = {
  id: 'primary-1',
  email: 'fixture-owner@example.invalid',
  note: '',
  status: 'ACTIVE',
  createdAt: now,
  updatedAt: now,
  imapHost: 'imap.mail.me.com',
  imapPort: 993,
  masterQueryCode: 'MSTR-TEST-TEST',
  codeExpiresAt: oldExpiry,
  codeResetIntervalDays: 30,
  remainingDays: 0,
  lastQueriedAt: null,
  lastQueriedIp: null,
  lastSyncedAt: null,
  lastSyncError: null,
  virtualEmailCount: 2
};
const aliases: V2VendureMailboxAlias[] = [30, 90].map((days, index) => ({
  id: `alias-${index}`,
  primaryAccountId: primary.id,
  primaryAccountEmail: primary.email,
  aliasEmail: `fixture-alias-${index}@example.invalid`,
  note: '',
  status: 'ACTIVE',
  buyerQueryCode: 'BUY-TEST-TEST',
  codeExpiresAt: oldExpiry,
  codeResetIntervalDays: days,
  remainingDays: 0,
  lastQueriedAt: null,
  lastQueriedIp: null,
  mailCount: 0,
  lastMailReceivedAt: null,
  createdAt: now,
  updatedAt: now
}));
function page<T>(items: T[]) {
  if (controls.failRead) throw new Error('模拟列表刷新失败');
  return { items: structuredClone(items), total: items.length, page: 1, pageSize: 20 };
}
async function recordWrite(kind: string, id: string, days: number) {
  controls.writes.push({ kind, id, days });
  if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
  if (controls.failWrite) throw new Error('模拟重置失败');
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
Object.assign(idBusinessV2WorkspaceApi, {
  listManagedMailboxes: async () => page(managed),
  getManagedMailboxQueryCodeSettings: async () => ({
    validityDays: 90,
    defaultValidityDays: 30,
    minValidityDays: 1,
    maxValidityDays: 365,
    rotationMode: 'manual',
    updatedAt: null
  }),
  rotateManagedMailboxQueryCode: async (id: string, days = 30) => {
    const expiresAt = await recordWrite('managed', id, days);
    const item = managed.find((row) => row.id === id)!;
    Object.assign(item, {
      queryCode: `FIXTURE-NEW-${controls.writes.length}`,
      queryCodeExpiresAt: expiresAt,
      queryCodeValidityDays: days
    });
    return { mailbox: structuredClone(item), buyerCredential: item.queryCode };
  }
});
Object.assign(vendureMailboxApi, {
  status: async () => ({ configured: true, connected: true, message: null }),
  health: async () => ({ status: 'unsupported', checkedAt: now, listeners: [], delivery: null }),
  primaryAccounts: async () => page([primary]),
  aliases: async () => page(aliases),
  mails: async () => page([]),
  resetPrimaryCode: async (id: string, days = 30) => {
    const expiresAt = await recordWrite('primary', id, days);
    Object.assign(primary, {
      masterQueryCode: `MSTR-FIXTURE-${controls.writes.length}`,
      codeExpiresAt: expiresAt,
      codeResetIntervalDays: days,
      remainingDays: days
    });
    return structuredClone(primary);
  },
  resetAliasCode: async (id: string, days = 30) => {
    const expiresAt = await recordWrite('alias', id, days);
    const item = aliases.find((row) => row.id === id)!;
    Object.assign(item, {
      buyerQueryCode: `BUY-FIXTURE-${controls.writes.length}`,
      codeExpiresAt: expiresAt,
      codeResetIntervalDays: days,
      remainingDays: days
    });
    return structuredClone(item);
  }
});
</script>
