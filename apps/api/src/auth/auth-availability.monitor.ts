import { Injectable } from '@nestjs/common';

const AUTH_AVAILABILITY_WINDOW_MS = 5 * 60 * 1000;

interface AuthAvailabilitySample {
  at: number;
  unavailable: boolean;
}

export interface AuthAvailabilitySnapshot {
  alert: boolean;
  consecutiveUnavailable: number;
  sampledAt: string;
  status: 'healthy' | 'degraded';
  totalChecks: number;
  unavailableChecks: number;
  unavailableRate: number;
  windowMs: number;
}

@Injectable()
export class AuthAvailabilityMonitor {
  private readonly samples: AuthAvailabilitySample[] = [];

  recordAvailable(at = Date.now()) {
    this.record({ at, unavailable: false });
  }

  recordUnavailable(at = Date.now()) {
    this.record({ at, unavailable: true });
  }

  getSnapshot(at = Date.now()): AuthAvailabilitySnapshot {
    this.prune(at);
    const totalChecks = this.samples.length;
    const unavailableChecks = this.samples.filter((sample) => sample.unavailable).length;
    const unavailableRate = totalChecks ? unavailableChecks / totalChecks : 0;
    const consecutiveUnavailable = this.getConsecutiveUnavailable();
    const alert = unavailableRate > 0.01 || consecutiveUnavailable >= 3;
    return {
      alert,
      consecutiveUnavailable,
      sampledAt: new Date(at).toISOString(),
      status: alert ? 'degraded' : 'healthy',
      totalChecks,
      unavailableChecks,
      unavailableRate,
      windowMs: AUTH_AVAILABILITY_WINDOW_MS
    };
  }

  private record(sample: AuthAvailabilitySample) {
    this.samples.push(sample);
    this.prune(sample.at);
  }

  private prune(at: number) {
    const cutoff = at - AUTH_AVAILABILITY_WINDOW_MS;
    while (this.samples[0] && this.samples[0].at < cutoff) this.samples.shift();
  }

  private getConsecutiveUnavailable() {
    let count = 0;
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      if (!this.samples[index]?.unavailable) break;
      count += 1;
    }
    return count;
  }
}
