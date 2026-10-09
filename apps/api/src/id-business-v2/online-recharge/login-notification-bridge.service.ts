import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuthLoginEvents } from '../../auth/login-events';
import { OnlineRechargeSecurityNotificationService } from './security-notification.service';

@Injectable()
export class OnlineRechargeLoginNotificationBridge implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;
  constructor(
    private readonly events: AuthLoginEvents,
    private readonly notifications: OnlineRechargeSecurityNotificationService
  ) {}
  onModuleInit() {
    this.unsubscribe = this.events.subscribe((event) => this.notifications.enqueue(event));
  }
  onModuleDestroy() {
    this.unsubscribe?.();
  }
}
