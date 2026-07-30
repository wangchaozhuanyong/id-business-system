const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 300;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const PRODUCTION_RELEASE_LOCK_REF = 'refs/tags/id-business-production-release-lock';

export function createWranglerRollbackArguments(versionId, config, message) {
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new Error('Cloudflare 回滚版本 ID 无效');
  }
  if (!config?.trim() || !message?.trim()) {
    throw new Error('Cloudflare 回滚必须包含配置文件和原因');
  }

  return ['rollback', versionId, '--config', config, '--message', message, '--yes'];
}

export async function fetchWithReleasePolicy(input, init = {}, options = {}) {
  const method = String(init.method ?? 'GET').toUpperCase();
  const isRetryableRead = method === 'GET';
  const attempts = isRetryableRead ? (options.readAttempts ?? DEFAULT_READ_ATTEMPTS) : 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;

  if (
    typeof fetchImpl !== 'function' ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 5 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(retryDelayMs) ||
    retryDelayMs < 0
  ) {
    throw new Error('线上请求策略参数无效');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetchImpl(input, {
        ...init,
        signal
      });
      if (
        !isRetryableRead ||
        !RETRYABLE_READ_STATUSES.has(response.status) ||
        attempt === attempts
      ) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // The next bounded attempt is still safe even if the failed response cannot be cancelled.
      }
    } catch (error) {
      lastError = error;
      if (!isRetryableRead || attempt === attempts) throw error;
    }

    await sleepImpl(retryDelayMs * attempt);
  }

  throw lastError ?? new Error('线上请求未返回结果');
}

export function getReleaseFailureRecovery(activeVersionId, deployedVersionId, rollbackVersionId) {
  for (const [label, versionId] of [
    ['当前活跃版本', activeVersionId],
    ['本次发布版本', deployedVersionId],
    ['发布前版本', rollbackVersionId]
  ]) {
    if (!VERSION_ID_PATTERN.test(versionId)) {
      throw new Error(`${label} ID 无效，不能生成安全恢复建议`);
    }
  }

  if (activeVersionId !== deployedVersionId) {
    return {
      action: 'manual-investigation',
      activeVersionId,
      rollbackVersionId: null
    };
  }
  return {
    action: 'manual-rollback',
    activeVersionId,
    rollbackVersionId
  };
}

export function getWranglerDeployVersionId(output) {
  const entries = String(output ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.type === 'deploy' && entry.version === 1);

  if (entries.length !== 1 || !VERSION_ID_PATTERN.test(entries[0]?.version_id ?? '')) {
    throw new Error('Wrangler 部署输出没有唯一有效的本次版本 ID');
  }
  return entries[0].version_id;
}

export function getSoleActiveVersionId(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  const activeVersions = [];
  let totalPercentage = 0;

  for (const version of versions) {
    const percentage = Number(version?.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error('Cloudflare 当前部署状态包含无效流量比例');
    }
    if (percentage === 0) continue;
    if (typeof version?.version_id !== 'string' || !VERSION_ID_PATTERN.test(version.version_id)) {
      throw new Error('Cloudflare 当前部署状态包含无效版本 ID');
    }
    activeVersions.push({
      percentage,
      versionId: version.version_id
    });
    totalPercentage += percentage;
  }

  if (
    activeVersions.length !== 1 ||
    activeVersions[0]?.percentage !== 100 ||
    totalPercentage !== 100
  ) {
    throw new Error('当前生产部署必须是单一版本承载 100% 流量，才能确定安全的人工回滚目标');
  }

  return activeVersions[0].versionId;
}

export function getDeploymentGitCommit(deployment, branch = 'main') {
  const message = deployment?.annotations?.['workers/message'];
  const escapedBranch = String(branch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match =
    typeof message === 'string'
      ? message.match(new RegExp(`^git:([0-9a-f]{40}) branch:${escapedBranch}$`))
      : null;
  if (!match) {
    throw new Error('Cloudflare 当前部署缺少可核验的完整 Git commit 标记');
  }
  return match[1];
}

export function createProductionReleaseLockAcquireArguments(leaseCommit) {
  if (!GIT_SHA_PATTERN.test(leaseCommit)) {
    throw new Error('生产发布锁提交无效');
  }
  return [
    'push',
    '--porcelain',
    `--force-with-lease=${PRODUCTION_RELEASE_LOCK_REF}:`,
    'origin',
    `${leaseCommit}:${PRODUCTION_RELEASE_LOCK_REF}`
  ];
}

export function createProductionReleaseLockReleaseArguments(leaseCommit) {
  if (!GIT_SHA_PATTERN.test(leaseCommit)) {
    throw new Error('生产发布锁提交无效');
  }
  return [
    'push',
    '--porcelain',
    `--force-with-lease=${PRODUCTION_RELEASE_LOCK_REF}:${leaseCommit}`,
    'origin',
    `:${PRODUCTION_RELEASE_LOCK_REF}`
  ];
}

export function getRemoteProductionReleaseLockCommit(output) {
  const rows = String(output ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (rows.length === 0) return '';
  if (rows.length !== 1) {
    throw new Error('远端生产发布锁状态不唯一');
  }
  const [commit, ref, ...extra] = rows[0].split(/\s+/);
  if (extra.length || !GIT_SHA_PATTERN.test(commit ?? '') || ref !== PRODUCTION_RELEASE_LOCK_REF) {
    throw new Error('远端生产发布锁状态无效');
  }
  return commit;
}

export function assertReleaseStillOwnsActiveVersion(activeVersionId, deployedVersionId) {
  if (activeVersionId !== deployedVersionId) {
    throw new Error('线上活跃版本已被其他发布替换，已停止自动回滚并转人工处置');
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
