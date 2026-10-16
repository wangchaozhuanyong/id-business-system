import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { RechargeSettingsService } from '../auto-recharge/public-api';
import { AppleMailboxesService } from './apple-mailboxes.service';
import { AutoRegistrationService } from './auto-registration.service';

type Action = 'claim' | 'event' | 'code' | 'result' | 'fail';
type Grant = {
  tokenHash: Buffer;
  nonceHash?: Buffer;
  operator: AuthenticatedUser;
  revalidate: () => Promise<boolean>;
  expiresAt: number;
  claimed: boolean;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** One task / one browser capability. No system session is sent to the connector. */
@Injectable()
export class BrowserRegistrationService implements OnModuleDestroy {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly mailboxes: AppleMailboxesService,
    private readonly worker: AutoRegistrationService,
    private readonly settings: RechargeSettingsService,
    private readonly audit: AuditLogsService
  ) {}

  onModuleDestroy() {
    this.grants.clear();
  }

  async start(
    value: unknown,
    operator: AuthenticatedUser,
    revalidate: () => Promise<boolean>,
    requestOrigin: unknown
  ) {
    if (!operator.roles.includes('admin')) throw new ForbiddenException('仅管理员可以注册账号');
    const origin = this.allowedOrigin(requestOrigin);
    for (const [id, grant] of this.grants)
      if (grant.expiresAt <= Date.now()) this.grants.delete(id);
    if (this.grants.size >= 64) throw new ConflictException('当前浏览器任务较多，请稍后重试');
    if (!(await revalidate())) throw new ForbiddenException('登录状态已变化，请重新登录');
    // Confirm the installed browser configuration before reserving an email. The selected
    // registration proxy remains owned by the worker, independent of recharge defaults.
    await this.settings.runtime(operator.id, true, true);
    const result = await this.mailboxes.start(value, operator, revalidate, 'browser');
    if (!uuid.test(result.taskUuid)) throw new ConflictException('注册任务返回异常，请核对记录');
    const launchToken = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30 * 60_000;
    this.grants.set(result.taskUuid, {
      tokenHash: digest(launchToken),
      operator,
      revalidate,
      expiresAt,
      claimed: false
    });
    await this.log(operator, '启动浏览器注册', result.taskUuid);
    return {
      ...result,
      launchToken,
      callbackBaseUrl: `${origin}/api/id-business-v2/auto-registration/browser/tasks/${result.taskUuid}`,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async callback(
    taskUuid: string,
    action: Action,
    authorization: unknown,
    nonce: unknown,
    body: unknown
  ): Promise<unknown> {
    if (!['claim', 'event', 'code', 'result', 'fail'].includes(action))
      throw new BadRequestException('浏览器操作无效');
    if (!body || typeof body !== 'object' || Array.isArray(body) || 'claimId' in body)
      throw new BadRequestException('浏览器请求参数无效');
    const grant = await this.authorize(taskUuid, authorization, nonce, action === 'claim');
    const path = `/internal/apple-mailboxes/browser/tasks/${taskUuid}/${action}`;
    if (action === 'claim') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new BadRequestException('浏览器启动参数无效');
      const config = await this.settings.runtime(grant.operator.id, true, true);
      const result = await this.worker.appleMailboxRequest<Record<string, unknown>>(
        path,
        'POST',
        { claimId: digest(nonce as string).toString('hex') },
        grant.operator.id
      );
      grant.claimed = true;
      await this.log(grant.operator, '浏览器接管注册任务', taskUuid);
      return {
        ...result,
        expiresAt: new Date(grant.expiresAt).toISOString(),
        bitBrowser: {
          apiUrl: config.localApiUrl,
          apiToken: config.localApiToken,
          browserOptions: config.browserOptions
        }
      };
    }
    if (!grant.claimed) throw new ConflictException('请先连接本任务的浏览器');
    const result = await this.worker.appleMailboxRequest(
      path,
      'POST',
      {
        ...body,
        claimId: digest(nonce as string).toString('hex')
      },
      grant.operator.id
    );
    // Payloads may contain credentials. Auditing is restricted to task identity and action.
    if (action === 'result' || action === 'fail')
      await this.log(
        grant.operator,
        action === 'result' ? '核对浏览器注册结果' : '浏览器注册停止',
        taskUuid
      );
    return result;
  }

  private async authorize(id: string, authorization: unknown, nonce: unknown, claim: boolean) {
    if (!uuid.test(id)) throw new BadRequestException('任务标识无效');
    const grant = this.grants.get(id);
    const token =
      typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
        ? authorization.slice(7)
        : '';
    if (
      !grant ||
      grant.expiresAt <= Date.now() ||
      !token ||
      !timingSafeEqual(grant.tokenHash, digest(token)) ||
      typeof nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)
    )
      throw new ForbiddenException('浏览器授权无效或已过期，请核对原任务');
    const nonceHash = digest(nonce);
    if (grant.nonceHash && !timingSafeEqual(grant.nonceHash, nonceHash))
      throw new ForbiddenException('任务已由另一个浏览器接管');
    if (!claim && !grant.nonceHash) throw new ForbiddenException('浏览器尚未接管任务');
    if (!(await grant.revalidate().catch(() => false)))
      throw new ForbiddenException('操作人登录状态已变化，请重新登录并核对原任务');
    // There is no await between compare and bind: concurrent claims cannot replace a nonce.
    if (grant.nonceHash && !timingSafeEqual(grant.nonceHash, nonceHash))
      throw new ForbiddenException('任务已由另一个浏览器接管');
    if (claim) grant.nonceHash = nonceHash;
    return grant;
  }

  private allowedOrigin(value: unknown) {
    const allowed = (process.env.CORS_ORIGIN ?? '').split(',').map((item) => item.trim());
    if (typeof value !== 'string' || !allowed.includes(value))
      throw new ForbiddenException('请从当前管理系统启动浏览器注册');
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      throw new BadRequestException('管理系统地址无效');
    }
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== value ||
      origin.username ||
      origin.password
    )
      throw new BadRequestException('浏览器注册需要安全的管理系统地址');
    return origin.origin;
  }

  private log(operator: AuthenticatedUser, action: string, taskUuid: string) {
    return this.audit.create({
      userId: operator.id,
      module: '自动注册',
      action,
      objectType: '隐藏邮箱注册记录',
      remark: taskUuid
    });
  }
}
