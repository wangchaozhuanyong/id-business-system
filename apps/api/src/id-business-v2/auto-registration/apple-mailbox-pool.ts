import type { RechargeProxyService } from '../auto-recharge/public-api';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  AppleMailboxSummary,
  AppleMailboxRecord,
  AppleMailboxRow
} from './apple-mailboxes.types';
export const appleMailboxUploadKeys = [
  'auto_upload_cpa',
  'cpa_service_ids',
  'auto_upload_sub2api',
  'sub2api_service_ids',
  'auto_upload_tm',
  'tm_service_ids'
];
export function appleMailboxRow(
  alias: AppleMailboxSummary,
  record?: AppleMailboxRecord,
  systemRegistered = false
): AppleMailboxRow {
  const registrationStatus = systemRegistered
    ? 'registered'
    : (record?.registrationStatus ?? 'unregistered');
  const blockedReason = record?.activeTaskUuid
    ? '邮箱已被任务占用，请查看进度或核对中断任务'
    : registrationStatus === 'unknown'
      ? '请先确认该邮箱是否已经注册'
      : registrationStatus === 'registered'
        ? '该邮箱已标记为已注册'
        : alias.status !== 'ACTIVE'
          ? '隐藏邮箱未启用'
          : !alias.primaryAvailable
            ? '所属主邮箱不可用'
            : !alias.authorizationValid
              ? '邮箱查询授权已失效'
              : null;
  return {
    aliasId: alias.id,
    email: alias.email,
    primaryEmail: alias.primaryEmail,
    mailboxStatus: alias.status,
    authorizationValid: alias.authorizationValid,
    primaryAvailable: alias.primaryAvailable,
    registrationStatus,
    registrationIp: record?.registrationIp ?? null,
    registrationIpSource: record?.registrationIpSource ?? null,
    source: record?.source ?? null,
    note: record?.note || alias.note,
    updatedAt: record?.markedAt ?? alias.updatedAt,
    revision: record?.revision ?? 0,
    taskUuid: record?.activeTaskUuid ?? record?.lastTaskUuid ?? null,
    taskStatus: record?.taskStatus ?? null,
    canRegister: blockedReason === null,
    blockedReason,
    localSaveStatus: record?.localSaveStatus ?? 'not_ready',
    syncStatus: record?.syncStatus ?? 'not_ready',
    systemAccountId: record?.systemAccountId ?? null,
    errorKind: record?.errorKind ?? record?.syncErrorKind ?? null,
    syncErrorKind: record?.syncErrorKind ?? null,
    identityStatus: record?.identityStatus,
    passwordStatus: record?.passwordStatus,
    stage: record?.stage,
    reason: record?.reason,
    lastHttpStatus: record?.lastHttpStatus ?? null,
    proxySource: record?.proxySource,
    proxyId: record?.proxyId ?? null,
    mailboxSelection: record?.mailboxSelection,
    firstFailure: record?.firstFailure ?? null
  };
}

export function appleMailboxAlias(aliases: AppleMailboxSummary[], id: string) {
  const alias = aliases.find((item) => item.id === id);
  if (!alias) throw new ConflictException('隐藏邮箱不存在或已移除，请刷新列表');
  return alias;
}

export function appleMailboxUploadOptions(input: Record<string, unknown>) {
  const options: Record<string, unknown> = {};
  for (const key of ['auto_upload_cpa', 'auto_upload_sub2api', 'auto_upload_tm']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid();
    options[key] = input[key] ?? false;
  }
  for (const key of ['cpa_service_ids', 'sub2api_service_ids', 'tm_service_ids']) {
    const ids = input[key] ?? [];
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)
    )
      invalid();
    options[key] = [...new Set(ids)];
  }
  return options;
}
export async function appleMailboxExecutionOptions(
  input: Record<string, unknown>,
  service: RechargeProxyService,
  operator: AuthenticatedUser,
  mailboxSelection: 'specified' | 'automatic'
) {
  const options: Record<string, unknown> = {
    ...appleMailboxUploadOptions(input),
    mailboxSelection,
    proxySource: 'default',
    proxyId: null
  };
  if (input.proxyId !== undefined && input.proxyId !== null && input.proxyId !== '') {
    if (typeof input.proxyId !== 'string') invalid();
    const proxyId = input.proxyId.trim();
    if (proxyId.length > 191 || !/^[a-zA-Z0-9_-]+$/.test(proxyId)) invalid();
    options.proxyId = proxyId;
    options.proxySource = 'system';
    options.system_proxy = await service.forRegistration(proxyId, operator);
  }
  return options;
}
function invalid(): never {
  throw new BadRequestException('邮箱列表或标记参数无效，请核对输入');
}

export async function appleMailboxProxyOptions(service: RechargeProxyService) {
  const proxies: { id: string; label: string; countryCode: string }[] = [];
  let page = 1;
  for (;;) {
    const result = await service.list({
      page: String(page),
      pageSize: '100',
      status: 'active'
    });
    proxies.push(
      ...result.items.map((item) => ({
        id: item.id,
        countryCode: item.countryCode,
        label: `${item.countryCode} · ${item.linkMask}`
      }))
    );
    if (page * result.pageSize >= result.total) break;
    page += 1;
  }
  return proxies;
}
