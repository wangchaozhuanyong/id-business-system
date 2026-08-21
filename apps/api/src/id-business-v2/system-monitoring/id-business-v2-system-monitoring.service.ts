import { Injectable } from '@nestjs/common';
import { V2_DATA_SCOPES } from '@apple-business/shared';
import { AuthAvailabilityMonitor } from '../../auth/auth-availability.monitor';
import {
  IdBusinessV2SystemMonitoringRepository,
  type AuthenticationProbeRow,
  type ChangeSyncProbeRow,
  type ExchangeRateProbeRow
} from './persistence/id-business-v2-system-monitoring.repository';

type MonitorStatus = 'healthy' | 'degraded' | 'unknown';

interface ProbeResult<T> {
  ok: boolean;
  value?: T;
  durationMs: number;
}

@Injectable()
export class IdBusinessV2SystemMonitoringService {
  constructor(
    private readonly repository: IdBusinessV2SystemMonitoringRepository,
    private readonly authAvailabilityMonitor: AuthAvailabilityMonitor
  ) {}

  async overview(now = new Date()) {
    const startedAt = Date.now();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [database, changeSync, exchangeRate, authentication] = await Promise.all([
      this.capture(() => this.repository.probeDatabase()),
      this.capture(() => this.repository.loadChangeSync()),
      this.capture(() => this.repository.loadExchangeRate()),
      this.capture(() => this.repository.loadAuthentication(since, now))
    ]);

    const databaseCheck = this.databaseCheck(database);
    const changeSyncCheck = this.changeSyncCheck(changeSync);
    const schedulerCheck = this.schedulerCheck(exchangeRate, now);
    const purchaseRateCheck = this.purchaseRateCheck(exchangeRate, now);
    const authenticationCheck = this.authenticationCheck(authentication);
    const authAvailability = this.authAvailabilityMonitor.getSnapshot(now.getTime());
    const authAvailabilityCheck = this.authAvailabilityCheck(authAvailability);
    const checks = [
      {
        key: 'api',
        title: 'API 探针',
        status: 'healthy' as const,
        value: '本次请求可用',
        detail: '管理端已完成受保护只读探针请求。'
      },
      databaseCheck,
      changeSyncCheck,
      schedulerCheck,
      purchaseRateCheck,
      authenticationCheck,
      authAvailabilityCheck
    ];

    return {
      overallStatus: this.overallStatus(checks.map((check) => check.status)),
      checks,
      authentication: authentication.ok
        ? authentication.value
        : { attempts: null, failed: null, abnormal: null, activeSessions: null },
      authAvailability,
      exchangeRate: this.exchangeRateDetails(exchangeRate),
      purchaseRate: this.purchaseRateDetails(exchangeRate),
      observabilityGaps: [
        {
          key: 'realtime_transport',
          title: 'Realtime 实时通道',
          status: 'unknown' as const,
          detail: '服务端当前只能证明版本补偿表可读，不能证明每个浏览器的私有频道已连接。'
        },
        {
          key: 'historical_errors',
          title: '应用错误历史',
          status: 'unknown' as const,
          detail: '当前未接入持久化错误聚合平台，不能提供历史错误率。'
        },
        {
          key: 'slow_requests',
          title: '慢请求历史',
          status: 'unknown' as const,
          detail: '当前逐请求返回总耗时、认证耗时与业务处理耗时，不保存慢请求时间序列。'
        },
        {
          key: 'backup_restore',
          title: '托管备份与恢复',
          status: 'unknown' as const,
          detail: '应用数据库内没有可信的托管备份或隔离恢复结果，需由目标环境验证。'
        }
      ],
      generatedAt: now.toISOString(),
      probeDurationMs: Math.max(0, Date.now() - startedAt),
      timezone: 'Asia/Shanghai'
    };
  }

  private databaseCheck(result: ProbeResult<Array<{ ok: number }>>) {
    return result.ok
      ? {
          key: 'database',
          title: '数据库只读连接',
          status: 'healthy' as const,
          value: `${result.durationMs} ms`,
          detail: 'SELECT 1 只读探针成功。'
        }
      : {
          key: 'database',
          title: '数据库只读连接',
          status: 'degraded' as const,
          value: '探针失败',
          detail: '数据库只读探针失败；响应不包含连接串或底层错误。'
        };
  }

  private changeSyncCheck(result: ProbeResult<ChangeSyncProbeRow>) {
    if (!result.ok || !result.value) {
      return {
        key: 'change_sync',
        title: '变更版本补偿',
        status: 'degraded' as const,
        value: '查询失败',
        detail: '无法读取业务 scope 版本补偿表。'
      };
    }
    const tracked = result.value._count._all;
    return {
      key: 'change_sync',
      title: '变更版本补偿',
      status: (tracked > 0 ? 'healthy' : 'unknown') as MonitorStatus,
      value: `${tracked}/${V2_DATA_SCOPES.length} 个 scope 已产生版本`,
      detail: result.value._max.updatedAt
        ? `最近版本变化：${result.value._max.updatedAt.toISOString()}`
        : '尚无 scope 版本记录；这不等于 Realtime 通道故障。'
    };
  }

  private schedulerCheck(result: ProbeResult<ExchangeRateProbeRow>, now: Date) {
    if (!result.ok || !result.value) {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'degraded' as const,
        value: '查询失败',
        detail: '无法读取调度设置或最近运行。'
      };
    }
    const { settings, latestRun } = result.value;
    if (!settings) {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'unknown' as const,
        value: '尚未配置',
        detail: '数据库中没有汇率采集设置。'
      };
    }
    if (!settings.autoEnabled) {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'healthy' as const,
        value: '按配置停用',
        detail: '自动采集已由设置明确停用。'
      };
    }
    if (this.executionMode() === 'manual_only') {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'degraded' as const,
        value: '配置冲突',
        detail: '数据库启用了自动采集，但当前运行环境只允许人工模式。'
      };
    }
    if (latestRun?.status === 'failed') {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'degraded' as const,
        value: '最近一次失败',
        detail: latestRun.errorCode ? `安全错误码：${latestRun.errorCode}` : '最近运行失败。'
      };
    }
    const staleRunning =
      latestRun?.status === 'running' &&
      now.getTime() - latestRun.startedAt.getTime() > 15 * 60_000;
    if (staleRunning) {
      return {
        key: 'exchange_scheduler',
        title: '汇率采集任务',
        status: 'degraded' as const,
        value: '运行超时',
        detail: '最近运行已超过 15 分钟仍未结束。'
      };
    }
    return {
      key: 'exchange_scheduler',
      title: '汇率采集任务',
      status: (latestRun ? 'healthy' : 'unknown') as MonitorStatus,
      value: latestRun ? `最近状态：${latestRun.status}` : '尚无运行记录',
      detail: settings.nextRunAt
        ? `下次计划时间：${settings.nextRunAt.toISOString()}`
        : '自动采集已开启，但未记录下次计划时间。'
    };
  }

  private authenticationCheck(result: ProbeResult<AuthenticationProbeRow>) {
    return result.ok && result.value
      ? {
          key: 'authentication',
          title: '认证状态存储',
          status: 'healthy' as const,
          value: `${result.value.activeSessions} 个有效会话`,
          detail: `最近 24 小时登录 ${result.value.attempts} 次，失败或阻断 ${result.value.failed} 次，异常标记 ${result.value.abnormal} 次。`
        }
      : {
          key: 'authentication',
          title: '认证状态存储',
          status: 'degraded' as const,
          value: '查询失败',
          detail: '无法汇总认证状态；响应不包含账号、IP 或设备信息。'
        };
  }

  private purchaseRateCheck(result: ProbeResult<ExchangeRateProbeRow>, now: Date) {
    if (!result.ok || !result.value) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'degraded' as const,
        value: '查询失败',
        detail: '无法读取收购汇率调度设置、最近批次或最新有效快照。'
      };
    }
    const { settings, latestRun, latestSnapshot } = result.value.purchaseRate;
    if (!settings) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'unknown' as const,
        value: '尚未配置',
        detail: '数据库中没有收购汇率采集设置。'
      };
    }
    if (!settings.autoEnabled) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'healthy' as const,
        value: '按配置停用',
        detail: '收购汇率自动采集已由管理员明确停用。'
      };
    }
    if (!process.env.CURRENCY_API_KEY?.trim()) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'degraded' as const,
        value: '供应商未配置',
        detail: '自动采集已开启，但服务端未配置 CurrencyAPI 密钥。'
      };
    }
    if (latestRun?.status === 'failed' || latestRun?.status === 'pending_review') {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'degraded' as const,
        value: latestRun.status === 'pending_review' ? '等待异常审核' : '最近一次失败',
        detail:
          latestRun.status === 'pending_review'
            ? `异常币种：${latestRun.abnormalCurrencyCodes.join('、') || '待查看批次详情'}。原报价继续有效。`
            : latestRun.errorCode
              ? `安全错误码：${latestRun.errorCode}。原报价继续有效。`
              : '最近一次自动采集失败，原报价继续有效。'
      };
    }
    if (
      latestRun?.status === 'running' &&
      now.getTime() - latestRun.startedAt.getTime() > 15 * 60_000
    ) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'degraded' as const,
        value: '运行超时',
        detail: '最近运行已超过 15 分钟，任务锁应由自动恢复逻辑关闭。'
      };
    }
    if (
      latestSnapshot &&
      now.getTime() - latestSnapshot.marketRateCapturedAt.getTime() > settings.staleMinutes * 60_000
    ) {
      return {
        key: 'purchase_rate_scheduler',
        title: '收购汇率采集任务',
        status: 'degraded' as const,
        value: '报价已过期',
        detail: `最近有效供应商数据时间：${latestSnapshot.marketRateCapturedAt.toISOString()}。`
      };
    }
    return {
      key: 'purchase_rate_scheduler',
      title: '收购汇率采集任务',
      status: (latestSnapshot ? 'healthy' : 'unknown') as MonitorStatus,
      value: latestSnapshot ? '最近报价有效' : '尚无有效报价',
      detail: settings.nextRunAt
        ? `下次计划时间：${settings.nextRunAt.toISOString()}`
        : '自动采集已开启，但未记录下次计划时间。'
    };
  }

  private authAvailabilityCheck(snapshot: ReturnType<AuthAvailabilityMonitor['getSnapshot']>) {
    const rate = `${(snapshot.unavailableRate * 100).toFixed(2)}%`;
    if (snapshot.totalChecks === 0) {
      return {
        key: 'authentication_availability',
        title: '认证服务 5 分钟可用性',
        status: 'unknown' as const,
        value: '尚无样本',
        detail: '当前 API 进程尚未记录受保护请求的认证可用性样本。'
      };
    }
    return {
      key: 'authentication_availability',
      title: '认证服务 5 分钟可用性',
      status: snapshot.alert ? ('degraded' as const) : ('healthy' as const),
      value: `${snapshot.unavailableChecks}/${snapshot.totalChecks} 不可用（${rate}）`,
      detail: snapshot.alert
        ? `已超过 1% 阈值或连续 3 次不可用；当前连续 ${snapshot.consecutiveUnavailable} 次。`
        : `未超过 1% 阈值，当前连续 ${snapshot.consecutiveUnavailable} 次不可用。`
    };
  }

  private exchangeRateDetails(result: ProbeResult<ExchangeRateProbeRow>) {
    if (!result.ok || !result.value) return null;
    const { settings, latestRun } = result.value;
    return {
      executionMode: this.executionMode(),
      settings: settings
        ? {
            ...settings,
            nextRunAt: settings.nextRunAt?.toISOString() ?? null,
            updatedAt: settings.updatedAt.toISOString()
          }
        : null,
      latestRun: latestRun
        ? {
            ...latestRun,
            startedAt: latestRun.startedAt.toISOString(),
            finishedAt: latestRun.finishedAt?.toISOString() ?? null
          }
        : null
    };
  }

  private purchaseRateDetails(result: ProbeResult<ExchangeRateProbeRow>) {
    if (!result.ok || !result.value) return null;
    const { settings, latestRun, latestSnapshot } = result.value.purchaseRate;
    return {
      providerConfigured: Boolean(process.env.CURRENCY_API_KEY?.trim()),
      settings: settings
        ? {
            autoEnabled: settings.autoEnabled,
            staleMinutes: settings.staleMinutes,
            abnormalChangeRate: settings.abnormalChangeRate.toString(),
            nextRunAt: settings.nextRunAt?.toISOString() ?? null,
            updatedAt: settings.updatedAt.toISOString()
          }
        : null,
      latestRun: latestRun
        ? {
            ...latestRun,
            startedAt: latestRun.startedAt.toISOString(),
            finishedAt: latestRun.finishedAt?.toISOString() ?? null
          }
        : null,
      latestSnapshotAt: latestSnapshot?.marketRateCapturedAt.toISOString() ?? null
    };
  }

  private executionMode() {
    return process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE === 'true' ||
      process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED === 'false'
      ? ('manual_only' as const)
      : ('automatic_capable' as const);
  }

  private overallStatus(statuses: MonitorStatus[]) {
    if (statuses.includes('degraded')) return 'degraded' as const;
    if (statuses.includes('unknown')) return 'partial' as const;
    return 'healthy' as const;
  }

  private async capture<T>(operation: () => Promise<T>): Promise<ProbeResult<T>> {
    const startedAt = Date.now();
    try {
      return {
        ok: true,
        value: await operation(),
        durationMs: Math.max(0, Date.now() - startedAt)
      };
    } catch {
      return {
        ok: false,
        durationMs: Math.max(0, Date.now() - startedAt)
      };
    }
  }
}
