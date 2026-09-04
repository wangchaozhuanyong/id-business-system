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

  async listGroups(accessToken: string, platform: 'antigravity' | 'gemini' = 'gemini') {
    const value = await this.request<unknown>(
      `/admin/groups/all?platform=${encodeURIComponent(platform)}`,
      accessToken
    );
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

  async listSubscriptionAccounts(accessToken: string) {
    const value = await this.request<unknown>(
      '/admin/accounts?page=1&page_size=1000&platform=antigravity',
      accessToken
    );
    const summaries = items(value).filter(
      (account) => account.platform === 'antigravity' && account.type === 'oauth'
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
      concurrency: number;
      id: number;
      label: string;
      loadFactor: number;
      models: string[];
      modelMapping: Record<string, string>;
      priority: number;
      rateMultiplier: number;
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
        concurrency: this.positiveNumber(account.concurrency, 1),
        id: Number(account.id),
        label: String(account.name || `账号 #${account.id}`),
        loadFactor: this.positiveNumber(account.load_factor, 20),
        models,
        modelMapping: Object.fromEntries(models.map((model) => [model, model])),
        priority: this.positiveNumber(account.priority, 99),
        rateMultiplier: this.positiveNumber(account.rate_multiplier, 1)
      });
    }
    return references.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }

  async listSubscriptionReferences(accessToken: string) {
    const accounts = await this.listSubscriptionAccounts(accessToken);
    return accounts
      .filter((account) => account.status === 'active')
      .map((account) => {
        const credentials = this.record(account.credentials);
        const rawMapping = this.record(credentials.model_mapping);
        const modelMapping = Object.fromEntries(
          Object.entries(rawMapping)
            .map(([model, target]) => [model.trim(), String(target ?? '').trim()])
            .filter(
              ([model, target]) =>
                model.startsWith('gemini-') &&
                target.startsWith('gemini-') &&
                !/(?:tts|audio|video)/i.test(target)
            )
        );
        const extra = this.record(account.extra);
        return {
          id: Number(account.id),
          label: String(account.name || `账号 #${account.id}`),
          models: Object.keys(modelMapping).sort(),
          modelMapping,
          concurrency: this.positiveNumber(account.concurrency, 1),
          loadFactor: this.positiveNumber(account.load_factor, 1),
          priority: this.positiveNumber(account.priority, 1),
          rateMultiplier: this.positiveNumber(account.rate_multiplier, 1),
          allowOverages: extra.allow_overages === true,
          mixedScheduling: extra.mixed_scheduling === true
        };
      })
      .filter((account) => account.models.length > 0)
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }

  generateAntigravityAuthUrl(proxyId: number | null, accessToken: string) {
    return this.request<Record<string, unknown>>('/admin/antigravity/oauth/auth-url', accessToken, {
      method: 'POST',
      body: JSON.stringify(proxyId ? { proxy_id: proxyId } : {})
    });
  }

  exchangeAntigravityCode(
    input: { code: string; proxyId: number | null; sessionId: string; state: string },
    accessToken: string
  ) {
    return this.request<Record<string, unknown>>(
      '/admin/antigravity/oauth/exchange-code',
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          code: input.code,
          session_id: input.sessionId,
          state: input.state,
          ...(input.proxyId ? { proxy_id: input.proxyId } : {})
        })
      }
    );
  }

  async createAntigravityAccount(input: {
    accessToken: string;
    accountLabel: string;
    deploymentKey: string;
    googleEmail: string;
    modelMapping: Record<string, string>;
    proxyId: number | null;
    settings: Record<string, unknown>;
    targetGroupId: number;
    tokenInfo: Record<string, unknown>;
  }) {
    const email = String(input.tokenInfo.email || input.googleEmail)
      .trim()
      .toLowerCase();
    if (
      !input.tokenInfo.access_token ||
      !input.tokenInfo.refresh_token ||
      !input.tokenInfo.project_id
    )
      throw new Error('Antigravity OAuth 没有返回完整凭据');
    const name = `Gemini-pro-${email.split('@')[0] || input.accountLabel}`;
    const credentials = {
      access_token: input.tokenInfo.access_token,
      refresh_token: input.tokenInfo.refresh_token,
      token_type: input.tokenInfo.token_type || 'Bearer',
      expires_at: String(input.tokenInfo.expires_at || ''),
      project_id: input.tokenInfo.project_id,
      email,
      ...(input.tokenInfo.plan_type ? { plan_type: String(input.tokenInfo.plan_type) } : {}),
      ...(input.tokenInfo._token_version
        ? { _token_version: String(input.tokenInfo._token_version) }
        : {}),
      model_mapping: input.modelMapping
    };
    const accounts = await this.listSubscriptionAccounts(input.accessToken);
    const matches = accounts.filter((account) => {
      const current = this.record(account.credentials);
      return (
        String(current.email || '')
          .trim()
          .toLowerCase() === email || account.name === name
      );
    });
    if (matches.length > 1) throw new Error(`线上存在多个同邮箱或同名订阅账号：${email}`);
    const body = {
      name,
      notes: `Gemini 订阅号；运营标记 ${input.accountLabel}`,
      platform: 'antigravity',
      type: 'oauth',
      credentials,
      extra: {
        allow_overages: input.settings.allowOverages === true,
        mixed_scheduling: input.settings.mixedScheduling === true
      },
      proxy_id: input.proxyId,
      concurrency: this.positiveNumber(input.settings.concurrency, 1),
      load_factor: this.positiveNumber(input.settings.loadFactor, 1),
      priority: this.positiveNumber(input.settings.priority, 1),
      rate_multiplier: this.positiveNumber(input.settings.rateMultiplier, 1),
      schedulable: false,
      status: 'active',
      group_ids: [input.targetGroupId]
    };
    const existing = matches[0];
    if (existing) {
      const id = Number(existing.id);
      await this.setSchedulable(id, false, input.accessToken);
      const current = await this.getAccount(id, input.accessToken);
      const currentCredentials = this.record(current.credentials);
      const updated = await this.updateAccount(
        id,
        {
          ...body,
          credentials: {
            ...this.nonSecretCredentials(currentCredentials),
            ...credentials
          }
        },
        input.accessToken
      );
      return { ...existing, ...updated, id };
    }
    const digest = createHash('sha256')
      .update(`${input.deploymentKey}:${email}`)
      .digest('hex')
      .slice(0, 32);
    const created = await this.request<Record<string, unknown>>(
      '/admin/accounts',
      input.accessToken,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `onboarding-antigravity-${digest}` },
        body: JSON.stringify(body)
      }
    );
    const id = Number(created.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('中转站没有返回账号 ID');
    await this.setSchedulable(id, false, input.accessToken);
    return created;
  }

  createGeminiApiKeyAccount(input: {
    accessToken: string;
    accountLabel: string;
    apiKey: string;
    deploymentKey: string;
    modelMapping: Record<string, string>;
    proxyId: number | null;
    settings?: Record<string, unknown>;
  }) {
    const body = {
      name: `Gemini API 3.7+TTS-${input.accountLabel}`,
      notes: 'Google AI Studio 预付费 3.7 + TTS 账号',
      platform: 'gemini',
      type: 'apikey',
      credentials: {
        api_key: input.apiKey,
        base_url: 'https://generativelanguage.googleapis.com',
        model_mapping: input.modelMapping
      },
      proxy_id: input.proxyId,
      concurrency: this.positiveNumber(input.settings?.concurrency, 1),
      load_factor: this.positiveNumber(input.settings?.loadFactor, 20),
      priority: this.positiveNumber(input.settings?.priority, 99),
      rate_multiplier: this.positiveNumber(input.settings?.rateMultiplier, 1),
      group_ids: [],
      schedulable: false
    };
    const digest = createHash('sha256')
      .update(`${input.deploymentKey}:${input.accountLabel}`)
      .digest('hex')
      .slice(0, 32);
    return this.request<Record<string, unknown>>('/admin/accounts', input.accessToken, {
      method: 'POST',
      headers: { 'Idempotency-Key': `onboarding-gemini-api-${digest}` },
      body: JSON.stringify(body)
    });
  }

  setAntigravityPrivacy(accountId: number, accessToken: string) {
    return this.request<Record<string, unknown>>(
      `/admin/accounts/${accountId}/set-privacy`,
      accessToken,
      { method: 'POST', body: '{}' }
    );
  }

  syncAntigravityModels(accountId: number, accessToken: string) {
    return this.request<Record<string, unknown>>(
      `/admin/accounts/${accountId}/models/sync-upstream`,
      accessToken,
      { method: 'POST', body: '{}' }
    );
  }

  async configureAntigravityAccount(
    accountId: number,
    modelMapping: Record<string, string>,
    settings: Record<string, unknown>,
    accessToken: string
  ) {
    const current = await this.getAccount(accountId, accessToken);
    const credentials = this.nonSecretCredentials(this.record(current.credentials));
    return this.updateAccount(
      accountId,
      {
        credentials: { ...credentials, model_mapping: modelMapping },
        extra: {
          ...this.record(current.extra),
          allow_overages: settings.allowOverages === true,
          mixed_scheduling: settings.mixedScheduling === true
        },
        concurrency: this.positiveNumber(settings.concurrency, 1),
        load_factor: this.positiveNumber(settings.loadFactor, 1),
        priority: this.positiveNumber(settings.priority, 1),
        rate_multiplier: this.positiveNumber(settings.rateMultiplier, 1)
      },
      accessToken
    );
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
    settings?: Record<string, unknown>;
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
      concurrency: this.positiveNumber(input.settings?.concurrency, 1),
      load_factor: this.positiveNumber(input.settings?.loadFactor, 20),
      priority: this.positiveNumber(input.settings?.priority, 99),
      rate_multiplier: this.positiveNumber(input.settings?.rateMultiplier, 1),
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

  async attachGroup(accountId: number, groupId: number, accessToken: string, priority = 99) {
    await this.request(`/admin/accounts/${accountId}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify({
        group_ids: [groupId],
        priority,
        status: 'active'
      })
    });
    await this.setSchedulable(accountId, true, accessToken);
    const current = await this.getAccount(accountId, accessToken);
    const groupIds = Array.isArray(current.group_ids)
      ? current.group_ids.map(Number)
      : Array.isArray(current.groups)
        ? current.groups.map((group) => Number(this.record(group).id))
        : [];
    if (current.schedulable !== true || !groupIds.includes(groupId))
      throw new Error('中转站账号未成功加入目标分组或启用调度');
    return current;
  }

  validateAdminSession(session: IdBusinessV2CloudBridgeSession) {
    if (typeof session.access_token !== 'string' || session.access_token.length < 10) {
      throw new Error('中转站登录没有返回访问令牌');
    }
    if (session.user?.role !== 'admin') throw new Error('该中转站账号不是管理员');
    return session;
  }

  private updateAccount(accountId: number, updates: Record<string, unknown>, accessToken: string) {
    return this.request<Record<string, unknown>>(`/admin/accounts/${accountId}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private nonSecretCredentials(credentials: Record<string, unknown>) {
    const preserved = { ...credentials };
    delete preserved.access_token;
    delete preserved.refresh_token;
    return preserved;
  }

  private positiveNumber(value: unknown, fallback: number) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
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
