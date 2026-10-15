import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { RechargeProxyRepository } from './proxy-pool.repository';
import { RechargeProxyService } from '../proxy-pool.service';
import { bankRechargeObject, bankRechargeId } from '../validation';
import { proxyConnectionVersion, safeProxyTestResult } from '../proxy-test';

function legacyProxy(value: string) {
  let url = value.trim();
  if (!url.includes('://')) {
    const match = /^([^:/\s]+):(\d{1,5}):([^:\r\n]+):([^\r\n]+)$/.exec(url);
    if (!match) throw new BadRequestException('代理地址格式无效');
    url = `http://${encodeURIComponent(match[3]!)}:${encodeURIComponent(match[4]!)}@${match[1]}:${match[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('代理地址格式无效');
  }
  const extraction =
    parsed.protocol === 'https:' &&
    parsed.hostname === 'api.ipdeep.com' &&
    parsed.pathname === '/api/Pro/DynamicIp/GetIpByGenerateLink' &&
    parsed.searchParams.has('id') &&
    Boolean(parsed.searchParams.get('id')) &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    !parsed.hash;
  return {
    url,
    connectionMode: extraction ? 'extraction' : 'direct',
    protocol: extraction ? 'http' : parsed.protocol.slice(0, -1)
  };
}

@Injectable()
export class OnlineProxyPoolRepository {
  constructor(
    private readonly pool: RechargeProxyService,
    private readonly repository: RechargeProxyRepository,
    private readonly encryption: FieldEncryptionService
  ) {}
  async list(query: Record<string, unknown>) {
    const result = await this.pool.list(
      Object.fromEntries(
        Object.entries(query)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)])
      )
    );
    return {
      ...result,
      items: result.items.map((row) => ({
        ...row,
        country: row.countryCode,
        displayHost: row.displayHost || row.linkMask
      }))
    };
  }
  async resolveId(tx: V2CommandTransaction, oldId: string) {
    return (await this.repository.resolveOnlineId(tx, oldId))?.proxyId ?? oldId;
  }
  async active(
    tx: V2CommandTransaction,
    requested?: string,
    canonical = false,
    expectedVersion?: string
  ) {
    const selected = requested
      ? canonical
        ? requested
        : await this.resolveId(tx, requested)
      : undefined;
    if (selected) await this.repository.lock(tx, selected);
    const rows = await this.repository.active(tx, selected);
    if (!rows.length)
      throw new ConflictException(requested ? '所选代理已停用或不存在' : '共用代理池没有启用代理');
    const row = rows[randomInt(rows.length)]!;
    const connectionVersion = proxyConnectionVersion(row);
    if (expectedVersion && expectedVersion !== connectionVersion)
      throw new ConflictException('代理连接资料已修改，请重新检测');
    return {
      id: row.id,
      connectionVersion,
      proxy_url: this.encryption.decrypt(row.urlEncrypted),
      connectionMode: row.connectionMode,
      protocol: row.protocol,
      host: row.displayHost
    };
  }
  async result(
    tx: V2CommandTransaction,
    requested: string,
    result: { ip: string | null; latencyMs: number | null; ok: boolean; errorCode?: unknown },
    canonical = false,
    expectedVersion?: string
  ) {
    const id = canonical ? requested : await this.resolveId(tx, requested);
    await this.repository.lock(tx, id);
    const row = await this.repository.findInTransaction(tx, id);
    if (!row || !expectedVersion || proxyConnectionVersion(row) !== expectedVersion)
      return { applied: false };
    const safe = safeProxyTestResult(result);
    await this.repository.update(tx, id, {
      exitIp: safe.ip,
      latencyMs: safe.latencyMs,
      testMessage: safe.message,
      testedAt: new Date()
    });
    return { applied: true };
  }
  async action(action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(raw);
    if (action === 'import') {
      if (!Array.isArray(input.proxies)) throw new BadRequestException('代理列表格式无效');
      return this.pool.importMany(
        {
          proxies: input.proxies.map((value) =>
            typeof value === 'string'
              ? {
                  ...legacyProxy(value),
                  countryCode: input.countryCode,
                  kind: input.kind,
                  remark: input.remark
                }
              : value
          )
        },
        operator,
        true,
        true
      );
    }
    const selected = Array.isArray(input.ids) ? input.ids : [input.id];
    if (!selected.length || selected.length > 500)
      throw new BadRequestException('每次需要选择 1 至 500 条代理');
    // Resolve aliases through the same transaction boundary used for each pool command.
    const ids = selected.map((value) => bankRechargeId(value));
    return this.pool.onlineBatch(ids, action, input, operator);
  }
}
