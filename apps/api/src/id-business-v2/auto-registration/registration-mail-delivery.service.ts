import {
  ConflictException,
  ForbiddenException,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { V2IdentityService } from '../../v2-auth/v2-identity.service';
import { MailEventsService } from '../workspace/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { RegistrationJobsService } from './registration-jobs.service';
import { registrationWorkerCommand } from './registration-worker';

@Injectable()
export class RegistrationMailDeliveryService
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap
{
  private unsubscribe?: () => void;
  private stopped = false;
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  constructor(
    private readonly events: MailEventsService,
    private readonly repository: RegistrationRepository,
    private readonly jobs: RegistrationJobsService,
    private readonly identity: V2IdentityService
  ) {}
  onModuleInit() {
    this.unsubscribe = this.events.subscribe(async (aliasId) => {
      for (const job of await this.repository.waitingMailJobs(aliasId)) await this.deliver(job.id);
    });
  }
  async onApplicationBootstrap() {
    for (const job of await this.repository.waitingMailJobs(null)) this.request(job.id);
  }
  onModuleDestroy() {
    this.stopped = true;
    this.unsubscribe?.();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }
  request(jobId: string, attempt = 0) {
    if (this.stopped || this.retries.has(jobId)) return;
    void this.deliver(jobId).catch(() => {
      if (this.stopped) return;
      this.retries.set(
        jobId,
        setTimeout(
          () => {
            this.retries.delete(jobId);
            this.request(jobId, attempt + 1);
          },
          Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
        )
      );
    });
  }
  deliver(jobId: string): Promise<void> {
    const current = this.deliveries.get(jobId);
    if (current) return current;
    const delivery = this.performDelivery(jobId).finally(() => this.deliveries.delete(jobId));
    this.deliveries.set(jobId, delivery);
    return delivery;
  }
  private async performDelivery(jobId: string) {
    if (this.stopped) return;
    const row = await this.repository.find(jobId);
    if (!row || row.state !== 'awaiting_email' || !row.leaseUntil || row.leaseUntil <= new Date())
      return;
    try {
      const operator = await this.identity.getAuthenticatedUser(row.ownerId);
      if (!operator.roles.includes('admin') || operator.mustResetPassword) return;
      const value = await this.jobs.code(jobId, operator);
      if (!value.code) return;
      const result = await registrationWorkerCommand(jobId, value.attempt, 'code', {
        attempt: value.attempt,
        step: value.step,
        code: value.code,
        mailId: value.mailId
      });
      if (result.delivery !== 'accepted')
        throw new ServiceUnavailableException('验证码投递尚未确认');
    } catch (error) {
      // Advancing/cancelled/revoked tasks never receive a late code.
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof UnauthorizedException
      )
        return;
      throw error;
    }
  }
}
