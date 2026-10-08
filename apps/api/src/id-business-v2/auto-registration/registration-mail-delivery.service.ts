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
  private readonly deliveries = new Map<string, { promise: Promise<void>; dirty: boolean }>();
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
      if (this.stopped || this.retries.has(jobId)) return;
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
    if (this.stopped) return Promise.resolve();
    const current = this.deliveries.get(jobId);
    if (current) {
      current.dirty = true;
      return current.promise;
    }
    const delivery = { promise: Promise.resolve(), dirty: false };
    delivery.promise = (async () => {
      try {
        do {
          delivery.dirty = false;
          // An empty lookup only repeats when a new trigger arrived during it.
          const empty = await this.performDelivery(jobId);
          const retry = this.retries.get(jobId);
          if (retry) {
            clearTimeout(retry);
            this.retries.delete(jobId);
          }
          if (!empty) return;
        } while (delivery.dirty && !this.stopped);
      } finally {
        if (this.deliveries.get(jobId) === delivery) this.deliveries.delete(jobId);
      }
    })();
    this.deliveries.set(jobId, delivery);
    return delivery.promise;
  }
  private async performDelivery(jobId: string): Promise<boolean> {
    if (this.stopped) return false;
    const row = await this.repository.find(jobId);
    if (
      !row ||
      row.state !== 'awaiting_email' ||
      !row.leaseUntil ||
      row.leaseUntil <= new Date() ||
      !row.nonceHash ||
      !row.codeRequestedAt
    )
      return false;
    const binding = {
      ownerId: row.ownerId,
      attempt: row.attempt,
      step: row.step,
      nonceHash: row.nonceHash,
      codeRequestedAt: row.codeRequestedAt.getTime(),
      lastMailId: row.lastMailId
    };
    try {
      const operator = await this.identity.getAuthenticatedUser(row.ownerId);
      if (this.stopped || !operator.roles.includes('admin') || operator.mustResetPassword)
        return false;
      const value = await this.jobs.code(jobId, operator);
      if (this.stopped) return false;
      if (!value.code) return true;
      const current = await this.repository.find(jobId);
      if (
        this.stopped ||
        !current ||
        current.state !== 'awaiting_email' ||
        !current.leaseUntil ||
        current.leaseUntil <= new Date() ||
        current.ownerId !== binding.ownerId ||
        current.attempt !== binding.attempt ||
        current.attempt !== value.attempt ||
        current.step !== binding.step ||
        current.step !== value.step ||
        current.nonceHash !== binding.nonceHash ||
        current.codeRequestedAt?.getTime() !== binding.codeRequestedAt ||
        current.lastMailId !== binding.lastMailId ||
        current.lastMailId === value.mailId
      )
        return false;
      const authorized = await this.identity.getAuthenticatedUser(current.ownerId);
      if (this.stopped || !authorized.roles.includes('admin') || authorized.mustResetPassword)
        return false;
      const result = await registrationWorkerCommand(jobId, value.attempt, 'code', {
        attempt: value.attempt,
        step: value.step,
        code: value.code,
        mailId: value.mailId
      });
      if (result.delivery !== 'accepted')
        throw new ServiceUnavailableException('验证码投递尚未确认');
      return false;
    } catch (error) {
      // Advancing/cancelled/revoked tasks never receive a late code.
      if (
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof UnauthorizedException
      )
        return false;
      throw error;
    }
  }
}
