import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  IdBusinessV2RelayRemoteError,
  idBusinessV2RelayFetchJson,
  unwrapIdBusinessV2RelayEnvelope
} from './id-business-v2-relay-http';

export const ID_BUSINESS_V2_CLOUDBRIDGE_ORIGIN = 'https://codexgemini.cc';
const CLOUDBRIDGE_BASE_URL = `${ID_BUSINESS_V2_CLOUDBRIDGE_ORIGIN}/api/v1`;

export interface IdBusinessV2CloudBridgeSession extends Record<string, unknown> {
  access_token: string;
  refresh_token?: string;
  user?: { email?: string; role?: string };
}

function items(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as Record<string, unknown>).items)
  ) {
    return ((value as Record<string, unknown>).items as unknown[]).filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')
    );
  }
  return [];
}

@Injectable()
export class IdBusinessV2RelayCloudBridgeClient {
  login(email: string, password: string) {
    return this.unauthenticated<IdBusinessV2CloudBridgeSession>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
  }

  login2FA(tempToken: string, totpCode: string) {
    return this.unauthenticated<IdBusinessV2CloudBridgeSession>('/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ temp_token: tempToken, totp_code: totpCode })
    });
  }

  refresh(refreshToken: string) {
    return this.unauthenticated<IdBusinessV2CloudBridgeSession>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken })
    });
  }

  async listGroups(accessToken: string) {
    const value = await this.request<unknown>('/admin/groups/all?platform=gemini', accessToken);
    return items(value);
  }

  async listProxies(accessToken: string) {
    const value = await this.request<unknown>('/admin/proxies/all?with_count=true', accessToken);
    return items(value);
  }

  async listVertexAccounts(accessToken: string) {
    const value = await this.request<unknown>(
      '/admin/accounts?page=1&page_size=1000&platform=gemini',
      accessToken
    );
    const summaries = items(value).filter(
      (account) => account.platform === 'gemini' && account.type === 'service_account'
    );
    return Promise.all(
      summaries.map((account) =>
        account.credentials ? account : this.getAccount(Number(account.id), accessToken)
      )
    );
  }

  async getAccount(accountId: number, accessToken: string) {
    return this.request<Record<string, unknown>>(`/admin/accounts/${accountId}`, accessToken);
  }

  async listVertexReferences(accessToken: string) {
    const accounts = await this.listVertexAccounts(accessToken);
    const references: Array<{
      id: number;
      label: string;
      models: string[];
      modelMapping: Record<string, string>;
    }> = [];
    for (const summary of accounts) {
      const account = summary;
      if (account.status !== 'active') continue;
      const credentials =
        account.credentials && typeof account.credentials === 'object'
          ? (account.credentials as Record<string, unknown>)
          : {};
      const rawMapping =
        credentials.model_mapping && typeof credentials.model_mapping === 'object'
          ? (credentials.model_mapping as Record<string, unknown>)
          : {};
      const models = Object.keys(rawMapping)
        .filter((model) => model.startsWith('gemini-'))
        .sort();
      if (!models.length) continue;
      references.push({
        id: Number(account.id),
        label: String(account.name || `账号 #${account.id}`),
        models,
        modelMapping: Object.fromEntries(models.map((model) => [model, model]))
      });
    }
    return references.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }

  async createVertexAccount(input: {
    accessToken: string;
    accountLabel: string;
    projectId: string;
    clientEmail: string;
    serviceAccountJson: Record<string, unknown>;
    location: string;
    creditExpiresAt: Date | null;
    modelMapping: Record<string, string>;
    proxyId: number | null;
  }) {
    const existing = (await this.listVertexAccounts(input.accessToken)).find((account) => {
      const credentials =
        account.credentials && typeof account.credentials === 'object'
          ? (account.credentials as Record<string, unknown>)
          : {};
      return credentials.project_id === input.projectId;
    });
    const body = {
      name: /^vertex(?:\s|[-_])/i.test(input.accountLabel)
        ? input.accountLabel
        : `Vertex ${input.accountLabel}`,
      notes: input.creditExpiresAt
        ? `Google Cloud Vertex AI 多模型账号；赠金到期日 ${input.creditExpiresAt.toISOString().slice(0, 10)}`
        : 'Google Cloud Vertex AI 多模型账号',
      platform: 'gemini',
      type: 'service_account',
      credentials: {
        client_email: input.clientEmail,
        location: input.location,
        model_mapping: input.modelMapping,
        project_id: input.projectId,
        service_account_json: JSON.stringify(input.serviceAccountJson),
        tier_id: 'vertex'
      },
      proxy_id: input.proxyId,
      concurrency: 1,
      load_factor: 20,
      priority: 99,
      rate_multiplier: 1,
      ...(existing ? {} : { group_ids: [] }),
      expires_at: input.creditExpiresAt ? Math.floor(input.creditExpiresAt.getTime() / 1000) : null,
      auto_pause_on_expired: Boolean(input.creditExpiresAt)
    };
    if (existing) {
      await this.setSchedulable(Number(existing.id), false, input.accessToken);
      const updated = await this.request<Record<string, unknown>>(
        `/admin/accounts/${Number(existing.id)}`,
        input.accessToken,
        { method: 'PUT', body: JSON.stringify(body) }
      );
      return { ...existing, ...updated, id: Number(existing.id) };
    }
    const digest = createHash('sha256')
      .update(`${input.projectId}:${JSON.stringify(body)}`)
      .digest('hex')
      .slice(0, 32);
    const created = await this.request<Record<string, unknown>>(
      '/admin/accounts',
      input.accessToken,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `onboarding-vertex-${digest}` },
        body: JSON.stringify({ ...body, group_ids: [] })
      }
    );
    const accountId = Number(created.id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      throw new Error('中转站没有返回账号 ID');
    }
    await this.setSchedulable(accountId, false, input.accessToken);
    return created;
  }

  async testAccount(accountId: number, model: string, accessToken: string) {
    const response = await fetch(`${CLOUDBRIDGE_BASE_URL}/admin/accounts/${accountId}/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Admin-UI-Request': '1'
      },
      body: JSON.stringify({
        model_id: model,
        mode: model.toLowerCase().includes('image') ? 'image' : 'default',
        prompt: model.toLowerCase().includes('tts')
          ? '请自然朗读：中转站语音测试成功。'
          : model.toLowerCase().includes('image')
            ? '生成一张纯绿色圆形图案，用于验证图片模型可用性。'
            : '只回复：中转站账号测试成功'
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(100_000)
    });
    if (!response.ok) {
      throw new IdBusinessV2RelayRemoteError(
        `中转站账号测试返回 HTTP ${response.status}`,
        'CLOUDBRIDGE_TEST_HTTP_ERROR',
        response.status
      );
    }
    const events = (await response.text())
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((event): event is Record<string, unknown> => Boolean(event));
    const failed = events.find((event) => event.type === 'error');
    const completed = events.find(
      (event) => event.type === 'test_complete' && event.success === true
    );
    if (failed || !completed) {
      throw new IdBusinessV2RelayRemoteError(
        failed ? `${model} 中转站单账号测试失败` : `${model} 测试没有成功完成`,
        'CLOUDBRIDGE_ACCOUNT_TEST_FAILED'
      );
    }
  }

  setSchedulable(accountId: number, schedulable: boolean, accessToken: string) {
    return this.request(`/admin/accounts/${accountId}/schedulable`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ schedulable })
    });
  }

  async attachGroup(accountId: number, groupId: number, accessToken: string) {
    await this.request(`/admin/accounts/${accountId}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify({
        group_ids: [groupId],
        priority: 99,
        status: 'active'
      })
    });
    return this.setSchedulable(accountId, true, accessToken);
  }

  validateAdminSession(session: IdBusinessV2CloudBridgeSession) {
    if (typeof session.access_token !== 'string' || session.access_token.length < 10) {
      throw new Error('中转站登录没有返回访问令牌');
    }
    if (session.user?.role !== 'admin') throw new Error('该中转站账号不是管理员');
    return session;
  }

  private async unauthenticated<T>(path: string, options: RequestInit) {
    const payload = await idBusinessV2RelayFetchJson(`${CLOUDBRIDGE_BASE_URL}${path}`, {
      ...options,
      headers: { 'X-Admin-UI-Request': '1', ...options.headers }
    });
    return unwrapIdBusinessV2RelayEnvelope<T>(payload);
  }

  private async request<T = unknown>(path: string, accessToken: string, options: RequestInit = {}) {
    const payload = await idBusinessV2RelayFetchJson(`${CLOUDBRIDGE_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Admin-UI-Request': '1',
        ...options.headers
      }
    });
    return unwrapIdBusinessV2RelayEnvelope<T>(payload);
  }
}
