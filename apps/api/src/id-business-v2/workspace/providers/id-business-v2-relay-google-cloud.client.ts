import { Injectable } from '@nestjs/common';
import { idBusinessV2RelayFetchJson } from './id-business-v2-relay-http';

const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v3';
const BILLING = 'https://cloudbilling.googleapis.com/v1';
const SERVICE_USAGE = 'https://serviceusage.googleapis.com/v1';
const IAM = 'https://iam.googleapis.com/v1';

export const ID_BUSINESS_V2_RELAY_GOOGLE_SERVICES = [
  'aiplatform.googleapis.com',
  'iam.googleapis.com',
  'serviceusage.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'cloudbilling.googleapis.com'
] as const;

interface GoogleOperation {
  done?: boolean;
  error?: { code?: number | string; message?: string };
  name?: string;
  response?: Record<string, unknown>;
}

@Injectable()
export class IdBusinessV2RelayGoogleCloudClient {
  private request<T>(url: string, accessToken: string, options: RequestInit = {}) {
    return idBusinessV2RelayFetchJson<T>(url, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
      timeoutMs: 60_000
    });
  }

  getProject(projectId: string, accessToken: string) {
    return this.request<Record<string, unknown>>(
      `${RESOURCE_MANAGER}/projects/${encodeURIComponent(projectId)}`,
      accessToken
    );
  }

  createProject(projectId: string, displayName: string, accessToken: string) {
    return this.request<GoogleOperation>(`${RESOURCE_MANAGER}/projects`, accessToken, {
      method: 'POST',
      body: JSON.stringify({ displayName, projectId })
    });
  }

  getResourceManagerOperation(name: string, accessToken: string) {
    return this.request<GoogleOperation>(
      `${RESOURCE_MANAGER}/${this.operationName(name)}`,
      accessToken
    );
  }

  async listBillingAccounts(accessToken: string) {
    const payload = await this.request<{ billingAccounts?: Array<Record<string, unknown>> }>(
      `${BILLING}/billingAccounts?pageSize=100`,
      accessToken
    );
    return (payload.billingAccounts ?? []).filter((account) => account.open === true);
  }

  linkBilling(projectId: string, billingAccount: string, accessToken: string) {
    return this.request<Record<string, unknown>>(
      `${BILLING}/projects/${encodeURIComponent(projectId)}/billingInfo`,
      accessToken,
      { method: 'PUT', body: JSON.stringify({ billingAccountName: billingAccount }) }
    );
  }

  startEnableServices(projectNumber: string, accessToken: string) {
    return this.request<GoogleOperation>(
      `${SERVICE_USAGE}/projects/${encodeURIComponent(projectNumber)}/services:batchEnable`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ serviceIds: ID_BUSINESS_V2_RELAY_GOOGLE_SERVICES })
      }
    );
  }

  getServiceUsageOperation(name: string, accessToken: string) {
    return this.request<GoogleOperation>(
      `${SERVICE_USAGE}/${this.operationName(name)}`,
      accessToken
    );
  }

  createServiceAccount(projectId: string, accessToken: string) {
    return this.request<Record<string, unknown>>(
      `${IAM}/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          accountId: 'cloudbridge-vertex',
          serviceAccount: { displayName: 'CloudBridge Vertex' }
        })
      }
    );
  }

  getServiceAccount(projectId: string, accessToken: string) {
    const email = `cloudbridge-vertex@${projectId}.iam.gserviceaccount.com`;
    return this.request<Record<string, unknown>>(
      `${IAM}/projects/-/serviceAccounts/${encodeURIComponent(email)}`,
      accessToken
    );
  }

  async grantProjectRole(projectId: string, member: string, role: string, accessToken: string) {
    const resource = `${RESOURCE_MANAGER}/projects/${encodeURIComponent(projectId)}`;
    const policy = await this.request<Record<string, unknown>>(
      `${resource}:getIamPolicy`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } })
      }
    );
    const bindings = Array.isArray(policy.bindings)
      ? (policy.bindings as Array<Record<string, unknown>>).map((binding) => ({ ...binding }))
      : [];
    let binding = bindings.find((item) => item.role === role && !item.condition);
    if (!binding) {
      binding = { role, members: [] };
      bindings.push(binding);
    }
    const members = Array.isArray(binding.members) ? binding.members.map(String) : [];
    binding.members = Array.from(new Set([...members, member])).sort();
    await this.request(`${resource}:setIamPolicy`, accessToken, {
      method: 'POST',
      body: JSON.stringify({
        policy: {
          auditConfigs: policy.auditConfigs,
          bindings,
          etag: policy.etag,
          version: Math.max(Number(policy.version ?? 1), 1)
        }
      })
    });
  }

  async createServiceAccountKey(serviceAccountEmail: string, accessToken: string) {
    const payload = await this.request<{ privateKeyData?: string }>(
      `${IAM}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}/keys`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          keyAlgorithm: 'KEY_ALG_RSA_2048',
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE'
        })
      }
    );
    if (!payload.privateKeyData) throw new Error('Google 没有返回服务账号密钥');
    const parsed = JSON.parse(
      Buffer.from(payload.privateKeyData, 'base64').toString('utf8')
    ) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('Google 服务账号密钥格式无效');
    return parsed as Record<string, unknown>;
  }

  assertOperationComplete(operation: GoogleOperation) {
    if (!operation.done) return null;
    if (operation.error) {
      throw new Error(operation.error.message || 'Google Cloud 异步操作失败');
    }
    return operation.response ?? {};
  }

  private operationName(value: string) {
    const name = value.trim().replace(/^\/+/, '');
    if (!/^[A-Za-z0-9._~/-]{3,500}$/.test(name) || name.includes('..')) {
      throw new Error('Google Cloud 操作标识无效');
    }
    return name;
  }
}
